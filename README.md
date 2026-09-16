# pi-accounts

Pi の同一セッション内で Codex アカウントを切り替える拡張。
初版は `openai-codex` の OAuth のみ対応し、Pi 0.85.1 で検証している。

## インストールと設定

ローカル checkout を登録する。

```bash
pi install /absolute/path/to/pi-accounts
```

`getAgentDir()` 配下の `accounts.json` に、設定内で一意の `id` と `provider` を指定する。
通常は `~/.pi/agent/accounts.json`、`PI_CODING_AGENT_DIR` を設定している場合はそのディレクトリになる。

```json
[
  { "id": "work", "provider": "openai-codex" },
  { "id": "personal", "provider": "openai-codex" }
]
```

ID は半角小文字英数字で始まる 1〜64 文字で、2 文字目以降は `_` と `-` も使える。
`label`、トークン、API キーなど、ほかの項目は保存しない。
設定が不正な場合は拡張の読み込みを停止する。
設定後、Pi を起動するか `/reload` を実行する。

## ログインと切り替え

Pi 標準の `/login` で、それぞれのアカウントにログインする。
ブラウザで認証する際は、意図した ChatGPT アカウントを選ぶ。
既存の `openai-codex` の認証情報はコピーしない。

```text
/login pi-accounts-codex-work
/login pi-accounts-codex-personal
/account work
```

- `/account`：ID の一覧から選択する。
- `/account work`：ID を直接指定する。入力補完も使える。
- 現在と同じモデル ID が切り替え先にあれば維持し、なければモデルを選択する。
- **切り替え後のリクエストは、同じ会話の履歴を別アカウントへ送る。** `/account` は実行前に確認する。
- 処理中の応答や継続処理が終わるまで待ち、認証の解決後にモデルを切り替える。
- 認証失敗時は再ログインを案内し、別アカウントや環境変数のキーへ自動で切り替えない。
- 現在の ID はフッターの `account: work` などで確認できる。これは選択中の ID であり、ログイン状態の監視表示ではない。

`/account` は TUI、または確認ダイアログに対応した RPC クライアントで使う。
print / JSON モードでは切り替えない。
非対話実行では、ログイン済みの provider を起動時に明示する。

```bash
pi --provider pi-accounts-codex-work --model gpt-5.4
```

モデル選択は標準の `/model` でも行えるが、その場合はこの拡張の引き継ぎ確認を通らない。
モデルの上書き設定には Pi 標準の `models.json` を使い、対象 provider に `pi-accounts-codex-work` などを指定する。
初版のカタログは Pi 同梱の Codex モデルを使い、動的カタログは扱わない。

## 保存先とアカウントの削除

認証情報は Pi の `auth.json` に、`pi-accounts-codex-<id>` ごとに保存される。
ログイン、トークン更新、排他的な保存、ログアウトは Pi が行う。
選択中の provider/model は Pi のセッション履歴に保存され、新規セッションのデフォルトは変更しない。

アカウントの追加は `accounts.json` を編集して `/reload` する。
削除するときは、先に別のアカウントへ切り替え、対象を標準の `/logout` でログアウトしてから設定を削除する。
設定から削除するだけでは認証情報は消えない。
同じ ID を使う別セッションにもログアウトは影響するが、別 ID の認証情報は変更しない。
ID を変更すると保存先も変わるため、新しい ID でログインし直す。

## 検証

開発には Node.js 22.19 以降を使う。
実行時の Pi パッケージはホストから提供されるため、拡張専用の実行時依存はない。

```bash
npm ci
npm run check
npm test
```

テストは合成 credential と隔離したディレクトリを使い、実アカウントの認証情報を読まない。
Pi の認証保存と更新、native serializer による tool-call replay、模擬 SSE 応答、コマンドのキャンセルと失敗、セッションの復元、依存なしでの CLI 読み込みを検証する。
アカウント間の切り替えでは、別アカウントの署名を Pi の履歴変換で除去し、同じアカウントかつ同じモデルの署名だけを保持する。
Pi 0.85.1 の実バイナリでも、合成認証情報で TUI の直接選択、一覧選択、確認のキャンセル、フッター更新、`/reload`、ログアウト後の再ログイン案内を確認した。

実 OAuth ログイン、外部への推論、実サーバーでの tool-call replay、WebSocket 通信、複数プロセス間の同時 refresh は未検証。
初版にはアカウント管理メニュー、ほかの provider、自動選択、認証の import/export を含めない。
設計調査は [`docs/research/pi-account-switcher.md`](docs/research/pi-account-switcher.md) を参照。
