# pi-accounts の設計調査

## 結論

`pi-account-switcher` を移植するより、小さな Pi 拡張としてスクラッチする。
アカウント選択の操作は参考にするが、認証ストレージ、モデル管理、秘密情報の解決、セッション状態の管理は可能な範囲で Pi に戻す。

同一セッション内の切り替えには、**アカウントごとに異なる provider ID を登録する設計**を第一候補とする。
Pi が provider ID ごとに認証を保存する仕組みをそのまま使い、切り替えは標準のモデル選択として扱う。
ただし、認証が分離できることと、全 provider の通信挙動をそのまま保てることは別である。
後述する provider ID 依存の処理を検証するまでは、汎用の完成済み方式とは扱わない。

本調査は設計提案であり、製品実装ではない。

## 確認したバージョン

- 参考拡張：[`hieplp/pi-account-switcher@053c299`](https://github.com/hieplp/pi-account-switcher/tree/053c2997bd9ec91664617abfb3021863af1517b2)。`package.json` のバージョンは `0.3.1`。
- 対象 Pi：[`v0.85.1 / d981de1`](https://github.com/earendil-works/pi/tree/d981de1229ef899957bbe968bc8dcda02a21f477)。調査時点の GitHub 最新公開リリースであり、ローカルの実行バージョンでもある。
- 変更前後の確認：Pi の `v0.80.7` と `v0.80.8`。

## 旧認証 API への依存は実在する

Pi 0.80.7 の `ModelRegistry` は `readonly authStorage: AuthStorage` を公開していた。
0.80.8 では内部の `ModelRuntime` に委譲する facade に変わり、`authStorage` がなくなった。
0.85.1 でも拡張の `ctx` に `modelRuntime` は公開されていない。
したがって、`ctx.modelRegistry.authStorage.set(...)` を `ctx.modelRuntime.…` に置換するだけでは移行できない。[1] [2] [3]

参考拡張は次の旧メソッドを呼んでいる。[4] [5]

- OAuth 切り替え：`authStorage.set()` と `reload()`。
- API キー切り替え：`setRuntimeApiKey()` と `removeRuntimeApiKey()`。
- 接続確認：`has()`、`get()`、`set()`、`remove()`、`reload()`。

`modelRegistry?.authStorage.set(...)` の optional chaining は `modelRegistry` だけを保護する。
`modelRegistry` が存在して `authStorage` がない現在の Pi では `TypeError` になる。
付属のオフライン検証でも、実際の 0.85.1 の `ModelRegistry` に対してこの失敗を確認した。

現在の役割分担は次のとおり。[2] [6] [7]

| 対象 | 役割 | 通常の拡張からの利用 |
| --- | --- | --- |
| `ModelRegistry` | モデル一覧、認証解決、provider 登録 | `ctx.modelRegistry` |
| `ModelRuntime` | 認証操作、モデル構成、利用可能モデルの同期 | SDK で自分が生成した runtime。稼働中の host の runtime は非公開 |
| `CredentialStore` | provider ID ごとの資格情報保存と排他的更新 | SDK の `ModelRuntime.create({ credentials })` に注入 |
| native `Provider` | ログイン、OAuth 更新、認証情報からのリクエスト生成、通信 | `pi.registerProvider(provider)` で登録 |

`ModelRuntime.setRuntimeApiKey()` は API キーの上書きであり、OAuth credential 全体を差し替えるためのメソッドではない。
`readStoredCredential()` も保存済み情報の読み取りであり、稼働中の認証の切り替えではない。[1] [6]

## 参考拡張の構造と引き継がない部分

参考拡張は `commands → runtime → services → storage` の構造を持つ。
`AccountSwitcher` の Interface にはアカウント選択以外に provider/model の管理まで並び、個々の service/store にも対応する操作がある。[8]
今回の目的には、Pi 自体と重複する管理機能を残す必要がない。

| 参考拡張の担当 | pi-accounts の方針 |
| --- | --- |
| アカウント選択、現在のアカウント表示 | 残す |
| 独自 provider/model CRUD | 作らない。Pi の `/model` と `models.json` を利用 |
| `literal/env/file/command/op` の独自 secret resolver | 原則作らない。Pi の保存済みキー、`$VAR`、`!command` を利用 |
| OAuth credential のコピーと再適用 | 作らない。ログインと更新の保存先を同じ account の provider ID に固定 |
| `state.json` の session ごとの active account/model、TTL、件数上限 | 原則不要。選択された provider/model は Pi がセッション履歴に保存 |
| CWD による自動選択、暗黙の provider 追従 | 初版には含めない |
| 独自 import/export、全アカウントへの ping | 初版には含めない |
| 子プロセス向けの one-shot 環境変数 | 作らない。必要時に起動側が明示的に account/provider を渡す |

Pi の key resolution は `!op read …` にも対応するが、command の出力はプロセス存続中にキャッシュされる。
外部で値を変更した際の即時反映までは約束しない。[9]

### API 変更とは別の設計上の問題

1. **OAuth credential が二重に保存される。**
   インポート時点の credential が `accounts.json` に保存され、切り替えるたびに Pi の認証へ書き戻される。
   Pi が refresh token を更新しても、その更新をアカウント側へ戻す処理は確認できなかった。
   再選択時に古い credential を復元し、refresh token のローテーションがある provider では認証に失敗し得る。[4] [10]
2. **セッション別の選択表示と認証の分離が一致しない。**
   選択状態は session ごとでも、OAuth は共通の provider の保存領域を上書きする。
   現行 Pi は別プロセスによる `auth.json` の更新も読み込むため、ファイルの差し替えを移行策にすると他セッションへ影響し得る。[8] [11]
3. **`process.env` の変更は認証選択の適切な単位ではない。**
   SDK で複数セッションを同一プロセスに置けば環境変数を共有する。
   また、子で環境変数を削除しても親の値は消えないため、子だけで消費する `NEXT_ID` は「次の一回」を保証しない。[4] [8] [12]
4. **切り替えにトランザクション相当の手順がない。**
   現在の認証を解除してから次の認証を適用し、モデル選択より先に active account を保存する。
   失敗やキャンセルで表示と実際の選択が食い違い得る。
   現行の extension command は streaming 中も呼ばれるため、idle 待ちも必要になる。[8] [13]

## 第一候補の設計

### 認証の保存単位

例として Codex の仕事用と個人用を登録する。
以下の ID は設計例であり、現在この repo に実装されているコマンドではない。

```text
account: work       → provider: pi-accounts-codex-work
account: personal   → provider: pi-accounts-codex-personal

Pi の auth.json
  pi-accounts-codex-work      → work の最新 credential
  pi-accounts-codex-personal  → personal の最新 credential

Pi セッション A → work の provider/model
Pi セッション B → personal の provider/model
```

native provider の認証処理と通信処理を再利用し、アカウント用の安定した ID とモデル一覧の provider ID を対応させる。
通常の `/login <account-provider-id>` がその ID に credential を保存し、通常の認証解決が同じ ID の credential を更新する。[7] [14]
ラベル変更では ID を変更しない。

独自設定に保存するのは、安定 ID、表示名、元の provider の対応だけにする。
パスは `getAgentDir()` 配下に置き、`~/.pi/agent` をハードコードしない。
credential と active account の複製は持たない。

### 利用者向け Interface

新しい slash command は **`/account` 一つ**を基本にする。

- `/account`：アカウント一覧から選択。
- `/account work`：名前または ID で直接選択。
- 追加や削除が必要なら、同じメニュー内の操作にする。
- ログイン、ログアウト、モデル選択は標準の `/login`、`/logout`、`/model` を利用。
- 現在のアカウントは `ctx.model.provider` から表示する。

標準の `/login` を `pi.sendUserMessage()` で実行できるとは仮定しない。
組み込み interactive command は extension command と同じ dispatch 対象ではないため、初版では必要な `/login <id>` を案内する。[13]

アカウント切り替えは、idle を待ち、対応するモデルと認証の利用可能性を確認し、`await pi.setModel(model)` の成功後に表示を更新する。
同じモデル ID が切り替え先にもあれば維持し、なければ利用者に選ばせる。
再ログインが必要な場合に、別アカウントや ambient API key に黙って退避しない。
同じ会話を別の組織のアカウントへ引き継ぐ操作であることも、切り替え UI で明示する。

この構成なら外部 Seam は `/account`、Pi との Seam は native provider 登録とモデル選択になる。
一実装しかない runtime/service/store の Interface 群を先に作る必要はない。

### 認証の分離だけでは確認できないこと

Pi の通信処理には `model.provider` の元の名前を判定する箇所がある。
したがって、provider を spread して ID だけ置き換えれば全挙動が等価になる、とは言えない。

- Anthropic の tool-reference の既定判定は `provider === "anthropic"` を使う。[15]
- Codex の tool-call ID 変換は特定の provider ID 集合を使う。[16]
- 異なる provider への会話引き継ぎでは、thinking signature や tool-call ID が変換される。[17]
- 動的カタログでは保存済みモデルの provider ID を照合する処理がある。[14]

初版は対象 provider を限定し、会話の継続と tool-call replay を検証する。
元の provider ID へ無条件に書き換えて通信すればよい、とも決めない。
異なるアカウント間で署名付き履歴を再利用してよいかは、provider ごとの確認が必要になる。
ID を分けた場合の互換性を小さな Adapter で維持できなければ、profile 分離案へ戻るか、Pi 本体に provider identity と credential identity の分離を提案する。

## 他の案との比較

| 案 | 適する用途 | 判断 |
| --- | --- | --- |
| `PI_CODING_AGENT_DIR` を account ごとに分けて起動 | 再起動、別プロセスでよい運用 | 最も小さく堅実。設定や拡張も分離され、同一 TUI 内の即時切り替えではない |
| アカウント別 native provider | 通常の Pi 拡張として同一セッション内で切り替え | 第一候補。認証保存を Pi に任せられるが、provider 固有の通信互換性を検証する |
| SDK に独自 `CredentialStore` を注入 | host/launcher も管理する製品 | 正式な Seam だが、通常の拡張だけでは host に注入できない |
| 共通 `auth.json` の書き換え、symlink の付け替え | 全セッション共通で認証を変える運用 | セッション別のアカウント選択には不採用 |
| 認証ヘッダーだけ hook で置換 | 限定的なリクエスト加工 | 更新、保存、モデル一覧、account 固有 endpoint を一貫して扱えず不採用 |
| private な `modelRegistry.runtime` をキャストして操作 | 一時的な内部改造 | 公開 Interface ではないため不採用 |

SDK 案を選ぶ場合も、`read(provider)` と `modify(provider)` の途中で active account が変わらない設計が必要になる。
OAuth refresh の開始時と保存時で保存先が変わる可変ルーターは避け、リクエストの認証解決中は保存先を固定する。
独自ストレージには account ごとの排他、複数プロセスからの更新、安全な永続化が必要になる。[7]

## 実施した検証

`auth-design-probe.ts` を Pi 0.85.1 の実バイナリで実行した。
実アカウントの credential は読まず、隔離した agent directory と合成 credential を使用した。
OAuth の `login`、`refresh`、`toAuth` をテスト用の処理に差し替え、Pi の認証制御と保存処理を検証した。

確認済みの範囲は次のとおり。

1. 実 `ModelRegistry` に `authStorage` がなく、旧呼び出しが `TypeError` になる。
2. 拡張の実 `ctx` に `modelRuntime` がない。
3. native provider の別 ID 登録が host のモデル一覧に反映される。
4. SDK の `ModelRuntime.login()` が別 ID に合成 credential を保存する。
5. 二つの account の更新後 refresh token が別々に永続化される。
6. 同一 account の並行認証解決で refresh が一度だけ実行される。
7. 元の `openai-codex` の credential は作成されない。

再実行例は repo root で以下を実行する。
テスト結果を確認できるよう、一時ディレクトリは自動削除しない。

```bash
test_dir=$(mktemp -d)
PI_CODING_AGENT_DIR="$test_dir" PI_OFFLINE=1 PI_TELEMETRY=0 \
  pi -p --no-session --no-context-files --no-extensions --no-skills \
  --no-prompt-templates --no-themes --no-tools --no-approve \
  -e ./docs/research/auth-design-probe.ts /auth-design-probe
```

**未確認**：実 OAuth ログイン、外部への推論リクエスト、アカウント切り替え後の tool-call replay、TUI での切り替え、別プロセス間の同時 refresh、動的カタログの互換性。
これらをオフライン検証の成功と混同しない。

## 実装前に決めること

- 初版の対象 provider。Codex だけか、Anthropic なども必要か。
- 同一セッション内での即時切り替えが必須か。不要なら profile 分離で足りる。
- provider ID を別名にすることによる会話引き継ぎの挙動を許容できるか。

実装に進む際は、対象 provider の通信互換性を先に小さく検証し、その後に `/account` の UI を作る。
先にアカウント管理フレームワークを作らない。

[1]: https://github.com/earendil-works/pi/releases/tag/v0.80.8
[2]: https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/model-registry.ts
[3]: https://github.com/earendil-works/pi/blob/v0.80.7/packages/coding-agent/src/core/model-registry.ts#L382
[4]: https://github.com/hieplp/pi-account-switcher/blob/053c2997bd9ec91664617abfb3021863af1517b2/src/utils/accounts.ts#L9-L72
[5]: https://github.com/hieplp/pi-account-switcher/blob/053c2997bd9ec91664617abfb3021863af1517b2/src/commands/accounts/verify.ts#L149-L233
[6]: https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/sdk.md#api-keys-and-oauth
[7]: https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/auth/types.ts#L35-L96
[8]: https://github.com/hieplp/pi-account-switcher/blob/053c2997bd9ec91664617abfb3021863af1517b2/src/runtime/account-switcher-runtime.ts
[9]: https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/providers.md#key-resolution
[10]: https://github.com/hieplp/pi-account-switcher/blob/053c2997bd9ec91664617abfb3021863af1517b2/src/commands/accounts/oauth.ts#L30-L52
[11]: https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/auth-storage.ts
[12]: https://github.com/hieplp/pi-account-switcher/blob/053c2997bd9ec91664617abfb3021863af1517b2/src/commands/accounts/set-subagent-account.ts
[13]: https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/extensions.md
[14]: https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/models.ts
[15]: https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/api/anthropic-messages.ts#L203-L215
[16]: https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/api/openai-responses-shared.ts#L158-L170
[17]: https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/api/transform-messages.ts
