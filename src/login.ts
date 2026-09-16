import { getAgentDir, ModelRuntime, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerLoginDefault(pi: ExtensionAPI, isAccountProvider: (provider: string) => boolean) {
  let detach: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    detach?.();
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
    // ponytail: Pi 0.85.1 needs guarded private-facade access; replace with a public
    // post-login event when available. Patch only this runtime, never the prototype.
    const runtime: unknown = Reflect.get(ctx.modelRegistry, "runtime");
    if (!(runtime instanceof ModelRuntime)) {
      ctx.ui.notify("この Pi ではログイン後のデフォルト保存を利用できません。/model の Ctrl+S で保存してください。", "warning");
      return;
    }
    const login = runtime.login;
    let active = true;
    const wrapped: ModelRuntime["login"] = async (provider, type, interaction) => {
      const credential = await login.call(runtime, provider, type, interaction);
      if (active && type === "oauth" && (provider === "openai-codex" || isAccountProvider(provider))) {
        try {
          const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: false });
          const models = runtime.getAvailableSnapshot().filter((model) => model.provider === provider);
          const model = models.find((model) => model.id === settings.getDefaultModel())
            ?? models.find((model) => model.id === ctx.model?.id) ?? models[0];
          if (!model) throw new Error("No available model");
          settings.setDefaultModelAndProvider(provider, model.id);
          await settings.flush();
          if (settings.drainErrors().length) throw new Error("Settings could not be saved");
          if (active) ctx.ui.notify("ログインしたアカウントを新規セッションのデフォルトに保存しました。現在の会話は切り替えません。", "info");
        } catch {
          // Do not turn a successful credential save into a login failure or expose secrets.
          if (active) ctx.ui.notify("ログインは完了しましたが、デフォルトを保存できませんでした。/model の Ctrl+S で保存してください。", "warning");
        }
      }
      return credential;
    };
    runtime.login = wrapped;
    detach = () => {
      active = false;
      if (runtime.login === wrapped) runtime.login = login;
    };
  });
  pi.on("session_shutdown", () => {
    detach?.();
    detach = undefined;
  });
}
