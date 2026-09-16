import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readAccounts } from "./accounts.ts";
import { accountProviderId, createCodexAccountProvider } from "./codex.ts";

export default async function (pi: ExtensionAPI) {
  const path = join(getAgentDir(), "accounts.json");
  const accounts = await readAccounts(path);
  for (const account of accounts) pi.registerProvider(createCodexAccountProvider(account.id));

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
    description: "Codex アカウントを選択（会話を切り替え先に引き継ぐ）",
    getArgumentCompletions(prefix) {
      const items = accounts.filter((account) => account.id.startsWith(prefix))
        .map((account) => ({ value: account.id, label: account.id }));
      return items.length ? items : null;
    },
    async handler(args, ctx) {
      if (!ctx.hasUI) {
        console.error("pi-accounts: /account は確認ダイアログを使える TUI または RPC で実行してください。");
        return;
      }
      if (switching) {
        ctx.ui.notify("アカウント切り替えの処理中です。", "warning");
        return;
      }
      if (!accounts.length) {
        ctx.ui.notify(`${path} に [{"id":"work","provider":"openai-codex"}] を設定し、/reload してください。`, "info");
        return;
      }
      switching = true;
      let provider: string | undefined;
      try {
        await ctx.waitForIdle();
        const id = args.trim() || await ctx.ui.select("アカウント（会話を切り替え先に引き継ぎます）", accounts.map((account) => account.id));
        if (!id) return;
        const account = accounts.find((entry) => entry.id === id);
        if (!account) {
          ctx.ui.notify("未登録の ID です。/account で一覧を確認してください。", "error");
          return;
        }
        provider = accountProviderId(account.id);
        await ctx.modelRegistry.refresh({ allowNetwork: false });
        const models = ctx.modelRegistry.getAvailable().filter((model) => model.provider === provider);
        if (!models.length) {
          ctx.ui.notify(`/login ${provider} でログインしてください。モデル設定は /model で確認できます。`, "warning");
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
          ctx.ui.notify(`/login ${provider} で OAuth ログインしてください。`, "warning");
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
