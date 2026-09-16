import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readAccounts, updateAccounts, type Account } from "./accounts.ts";
import { accountProviderId, createCodexAccountProvider } from "./codex.ts";
import { registerLoginDefault } from "./login.ts";

export default async function (pi: ExtensionAPI) {
  const path = join(getAgentDir(), "accounts.json");
  let accounts = await readAccounts(path);
  for (const account of accounts) pi.registerProvider(createCodexAccountProvider(account.id));
  registerLoginDefault(pi, (provider) => accounts.some((account) => accountProviderId(account.id) === provider));

  function syncAccounts(next: Account[]) {
    for (const account of accounts) {
      if (!next.some((entry) => entry.id === account.id)) pi.unregisterProvider(accountProviderId(account.id));
    }
    for (const account of next) {
      if (!accounts.some((entry) => entry.id === account.id)) pi.registerProvider(createCodexAccountProvider(account.id));
    }
    accounts = next;
  }

  function promptLogin(ctx: ExtensionContext, provider: string) {
    const command = `/login ${provider}`;
    ctx.ui.notify(`${command} でログインすると、新規セッションのデフォルトになります。現在の会話の切り替えは /account で行ってください。`, "info");
    if (ctx.mode === "tui" && !ctx.ui.getEditorText()) ctx.ui.setEditorText(command);
  }

  function setStatus(ctx: ExtensionContext, provider = ctx.model?.provider) {
    const account = accounts.find((entry) => accountProviderId(entry.id) === provider);
    if (ctx.hasUI) ctx.ui.setStatus("pi-accounts", account ? `account: ${account.id}` : undefined);
  }
  pi.on("session_start", (_event, ctx) => setStatus(ctx));
  pi.on("model_select", (event, ctx) => setStatus(ctx, event.model.provider));
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("pi-accounts", undefined);
  });

  let switching = false;
  pi.registerCommand("account", {
    description: "Codex アカウントを切り替え。追加: /account add 名前、削除: /account remove 名前",
    getArgumentCompletions(prefix) {
      const values = prefix.startsWith("remove ")
        ? accounts.map((account) => `remove ${account.id}`)
        : [...accounts.map((account) => account.id), "add ", "remove "];
      const items = values.filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    async handler(args, ctx) {
      if (!ctx.hasUI) {
        console.error("pi-accounts: /account は確認ダイアログを使える TUI または RPC で実行してください。");
        return;
      }
      if (switching) {
        ctx.ui.notify("アカウント操作の処理中です。", "warning");
        return;
      }
      switching = true;
      let provider: string | undefined;
      try {
        await ctx.waitForIdle();
        syncAccounts(await readAccounts(path));
        setStatus(ctx);
        const management = args.trim().match(/^(add|remove)\s+(\S+)$/);
        if (management) {
          const action = management[1] === "add" ? "add" : "remove";
          const id = management[2];
          const exists = accounts.some((account) => account.id === id);
          if (action === "add" && exists) {
            ctx.ui.notify("同じ名前のアカウントが登録済みです。/account で一覧を確認してください。", "warning");
            return;
          }
          if (action === "remove") {
            if (!exists) {
              ctx.ui.notify("未登録のアカウントです。", "warning");
              return;
            }
            provider = accountProviderId(id);
            if (ctx.model?.provider === provider) {
              ctx.ui.notify("先に /account または /model で別のアカウントへ切り替えてください。", "warning");
              return;
            }
            await ctx.modelRegistry.refresh({ allowNetwork: false });
            if (ctx.modelRegistry.getProviderAuthStatus(provider).configured) {
              ctx.ui.notify(`/logout で ${id} をログアウトしてから、/account remove ${id} を実行してください。`, "warning");
              return;
            }
            if (!await ctx.ui.confirm(`${id} を登録から削除しますか？`, "ほかのアカウントの設定は変更しません。")) return;
          }
          let next: Account[];
          try {
            next = await updateAccounts(path, action, id);
          } catch {
            ctx.ui.notify("設定を更新できませんでした。名前は半角小文字英数字で始まる1〜64文字（_ と - も使用可）です。保存先の権限や別プロセスでの更新も確認してください。", "error");
            return;
          }
          syncAccounts(next);
          ctx.ui.notify(`${id} を${action === "add" ? "追加" : "削除"}しました。`, "info");
          if (action === "add") promptLogin(ctx, accountProviderId(id));
          return;
        }
        if (!accounts.length) {
          ctx.ui.notify("/account add 名前 でアカウントを追加してください（例: /account add work）。", "info");
          return;
        }
        const id = args.trim() || await ctx.ui.select("アカウント（会話を切り替え先に引き継ぎます）", accounts.map((account) => account.id));
        if (!id) return;
        const account = accounts.find((entry) => entry.id === id);
        if (!account) {
          ctx.ui.notify("未登録の ID です。追加は /account add 名前、一覧は /account で確認してください。", "error");
          return;
        }
        provider = accountProviderId(account.id);
        await ctx.modelRegistry.refresh({ allowNetwork: false });
        const models = ctx.modelRegistry.getAvailable().filter((model) => model.provider === provider);
        if (!models.length) {
          promptLogin(ctx, provider);
          return;
        }
        let model = models.find((candidate) => candidate.id === ctx.model?.id);
        if (!model) {
          const modelId = await ctx.ui.select(`${account.id} のモデル`, models.map((candidate) => candidate.id));
          model = models.find((candidate) => candidate.id === modelId);
          if (!model) return;
        }
        const sameAccount = ctx.model?.provider === provider;
        if (!sameAccount && !await ctx.ui.confirm(`アカウントを ${account.id} に切り替えますか？`,
          "次のリクエストから、この会話の履歴を切り替え先のアカウント（別の組織の場合もあります）へ送信します。")) return;

        const auth = await ctx.modelRegistry.getProviderAuth(provider);
        if (!auth?.auth.apiKey || auth.source !== "OAuth") {
          promptLogin(ctx, provider);
          return;
        }
        if (sameAccount) {
          setStatus(ctx);
          return;
        }
        await ctx.waitForIdle();
        if (!await pi.setModel(model)) {
          ctx.ui.notify(`切り替えできませんでした。/login ${provider} で再認証してください。`, "error");
          return;
        }
        setStatus(ctx);
        ctx.ui.notify(`account: ${account.id}`, "info");
      } catch {
        // Auth errors may contain server responses; never display credentials.
        ctx.ui.notify(provider
          ? `切り替えに失敗しました。/login ${provider} で認証を確認し、再実行してください。`
          : "切り替えに失敗しました。再実行してください。", "error");
      } finally {
        switching = false;
      }
    },
  });
}
