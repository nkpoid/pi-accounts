import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore, type OAuthCredential } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import accountsExtension from "../src/index.ts";
import { accountProviderId, createCodexAccountProvider } from "../src/codex.ts";

test("last successful Codex login becomes the persisted startup default, not a live session switch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-login-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network access"); });
  const credentials = new InMemoryCredentialStore();
  const work = accountProviderId("work");
  const personal = accountProviderId("personal");
  const defaultModel = createCodexAccountProvider("work").getModels()[1].id;
  const settingsPath = join(dir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({
    defaultProvider: "openai-codex", defaultModel, theme: "light", defaultThinkingLevel: "high",
  }));
  await writeFile(join(dir, "accounts.json"), JSON.stringify([
    { id: "work", provider: "openai-codex" }, { id: "personal", provider: "openai-codex" },
  ]));
  const saved = async () => JSON.parse(await readFile(settingsPath, "utf8"));
  const interaction = { async prompt() { throw new Error("Unexpected prompt"); }, notify() {} };
  const credential: OAuthCredential = {
    type: "oauth", access: "secret-token", refresh: "synthetic", expires: Date.now() + 3_600_000,
  };
  await credentials.modify("openai-codex", async () => credential);
  async function services() {
    const modelRuntime = await ModelRuntime.create({
      credentials, modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "models-store.json"),
      allowModelNetwork: false,
    });
    return createAgentSessionServices({
      cwd: dir, agentDir: dir, modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
        extensionFactories: [accountsExtension],
      },
    });
  }
  const initial = await services();
  const runtime = initial.modelRuntime;
  const nativeModel = runtime.getModels("openai-codex")[0];
  const { session } = await createAgentSessionFromServices({
    services: initial, sessionManager: SessionManager.inMemory(dir), noTools: "all", model: nativeModel,
  });
  t.after(() => session.dispose());
  const notifications: string[] = [];
  let status: string | undefined;
  const ui: Partial<ExtensionUIContext> = {
    notify(text) { notifications.push(text); }, setStatus(_key, text) { status = text; },
  };
  const originalLogin = runtime.login;
  await session.bindExtensions({ mode: "tui", uiContext: ui as ExtensionUIContext });
  async function login(providerId: string) {
    const provider = runtime.getProvider(providerId)!;
    runtime.registerNativeProvider({ ...provider, auth: { oauth: {
      ...provider.auth.oauth!, async login() { return credential; },
    } } });
    return runtime.login(providerId, "oauth", interaction);
  }
  await login(work);
  assert.deepEqual(await saved(), {
    defaultProvider: work, defaultModel, theme: "light", defaultThinkingLevel: "high",
  });
  assert.equal(session.model?.provider, "openai-codex");
  assert.equal(session.model?.id, nativeModel.id);
  assert.equal(status, undefined);

  // The same startup services as the CLI load the saved choice before model selection.
  const fresh = await services();
  const { session: next } = await createAgentSessionFromServices({
    services: fresh, sessionManager: SessionManager.inMemory(dir), noTools: "all",
  });
  t.after(() => next.dispose());
  await next.bindExtensions({ mode: "tui", uiContext: ui as ExtensionUIContext });
  assert.equal(next.model?.provider, work);
  assert.equal(next.model?.id, defaultModel);
  assert.equal(status, "account: work");
  next.sessionManager.appendMessage({ role: "user", content: "Existing conversation", timestamp: 0 });

  await login(personal);
  assert.equal((await saved()).defaultProvider, personal);
  assert.equal(next.model?.provider, work); // Other running sessions do not follow the new default.
  assert.equal(session.model?.provider, "openai-codex");
  const restarted = await services();
  for (const [sessionManager, model, expected] of [
    [SessionManager.inMemory(dir), undefined, personal],
    [next.sessionManager, undefined, work],
    [SessionManager.inMemory(dir), nativeModel, "openai-codex"],
  ] as const) {
    const { session: opened } = await createAgentSessionFromServices({
      services: restarted, sessionManager, model, noTools: "all",
    });
    assert.equal(opened.model?.provider, expected); // New, resumed, explicit model.
    opened.dispose();
  }

  // Cancellation and failed credential persistence must not replace the successful default.
  const oauth = runtime.getProvider(work)!.auth.oauth!;
  const rejected = t.mock.method(oauth, "login", async () => { throw new Error("Login cancelled"); });
  await assert.rejects(runtime.login(work, "oauth", interaction), /Login cancelled/);
  rejected.mock.restore();
  const failedWrite = t.mock.method(credentials, "modify", async () => { throw new Error("secret-token write failed"); });
  await assert.rejects(runtime.login(work, "oauth", interaction));
  failedWrite.mock.restore();
  assert.equal((await saved()).defaultProvider, personal);

  await login("openai-codex"); // The standard Codex account also participates.
  assert.equal((await saved()).defaultProvider, "openai-codex");
  await login("anthropic"); // Unrelated providers must not change the Codex default.
  assert.equal((await saved()).defaultProvider, "openai-codex");
  const beforeFailure = await readFile(settingsPath, "utf8");
  await writeFile(settingsPath, "secret-token invalid JSON");
  assert.deepEqual(await login(work), credential); // Login still succeeds if settings cannot be saved.
  assert.equal(await readFile(settingsPath, "utf8"), "secret-token invalid JSON");
  assert.match(notifications.at(-1)!, /保存できません/);
  assert(!notifications.join("\n").includes("secret-token"));
  await writeFile(settingsPath, beforeFailure);

  await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
  assert.equal(runtime.login, originalLogin);
  await login(personal);
  assert.equal((await saved()).defaultProvider, "openai-codex"); // Shutdown detached the hook.
  await session.bindExtensions({ mode: "tui", uiContext: ui as ExtensionUIContext });
  await session.bindExtensions({ mode: "tui", uiContext: ui as ExtensionUIContext });
  const before = notifications.length;
  await login(personal);
  assert.equal(notifications.length, before + 1); // Rebinding never stacks hooks.
  assert.equal((await saved()).defaultProvider, personal);
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  await next.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
});
