import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession, createAgentSessionFromServices, createAgentSessionServices,
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionCommandContextActions, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import accountsExtension from "../src/index.ts";
import { readAccounts, updateAccounts } from "../src/accounts.ts";
import { accountProviderId } from "../src/codex.ts";

test("/account uses Pi model selection, consent, idle waiting, and session-derived status", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-extension-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network access"); });
  await writeFile(join(dir, "accounts.json"), JSON.stringify([
    { id: "work", provider: "openai-codex" },
    { id: "personal", provider: "openai-codex" },
    { id: "unconfigured", provider: "openai-codex" },
  ]));
  const credentials = new InMemoryCredentialStore();
  for (const provider of ["openai-codex", accountProviderId("work"), accountProviderId("personal")]) {
    await credentials.modify(provider, async () => ({
      type: "oauth", access: `${provider}-synthetic`, refresh: "synthetic", expires: Date.now() + 3_600_000,
    }));
  }
  const runtime = await ModelRuntime.create({
    credentials, modelsPath: join(dir, "models.json"),
    modelsStorePath: join(dir, "models-store.json"), allowModelNetwork: false,
  });
  const settings = SettingsManager.inMemory();
  const settingsPath = join(dir, "settings.json");
  const saved = async () => JSON.parse(await readFile(settingsPath, "utf8"));
  await writeFile(settingsPath, JSON.stringify({
    defaultProvider: "openai-codex", defaultModel: runtime.getModels("openai-codex")[0].id,
    theme: "light",
  }));
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [accountsExtension],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const nativeModel = runtime.getModels("openai-codex")[0];
  const { session, extensionsResult } = await createAgentSession({
    cwd: dir, agentDir: dir, resourceLoader: loader, modelRuntime: runtime,
    model: nativeModel, noTools: "all", settingsManager: settings, sessionManager: SessionManager.inMemory(dir),
  });
  t.after(() => session.dispose());
  let status: string | undefined;
  const notifications: string[] = [];
  const choices: (string | undefined)[] = [];
  const dialogs: string[] = [];
  let consent = false;
  let idle = Promise.resolve();
  let idleCalls = 0;
  const ui: Partial<ExtensionUIContext> = {
    setStatus(_key: string, text: string | undefined) { status = text; },
    getEditorText() { return ""; },
    setEditorText() {},
    notify(text: string) { notifications.push(text); },
    async select(title: string) { dialogs.push(title); return choices.shift(); },
    async confirm(_title: string, text: string) {
      assert.match(text, /会話の履歴/);
      return consent;
    },
  };
  await session.bindExtensions({
    mode: "tui", uiContext: ui as ExtensionUIContext,
    commandContextActions: { async waitForIdle() { idleCalls++; await idle; } } as ExtensionCommandContextActions,
  });
  assert.equal(status, undefined);
  assert(runtime.getModel(accountProviderId("work"), nativeModel.id));
  const command = extensionsResult.extensions[0].commands.get("account")!;
  assert.deepEqual(await command.getArgumentCompletions!("w"), [{ value: "work", label: "work" }]);
  assert.equal(await command.getArgumentCompletions!("missing"), null);

  await session.prompt("/account missing");
  assert.match(notifications.at(-1)!, /未登録/);
  await session.prompt("/account unconfigured");
  assert.match(notifications.at(-1)!, /\/login pi-accounts-codex-unconfigured/);
  await session.prompt("/account work"); // declined consent
  assert.equal(session.model?.provider, "openai-codex");
  assert.equal(status, undefined);
  assert.equal((await saved()).defaultProvider, "openai-codex");
  consent = true;
  let release!: () => void;
  idle = new Promise<void>((resolve) => { release = resolve; });
  const idleBeforeSwitch = idleCalls;
  const switching = session.prompt("/account work");
  await session.prompt("/account personal");
  assert.match(notifications.at(-1)!, /処理中/);
  assert.equal(session.model?.provider, "openai-codex");
  release();
  await switching;
  assert.equal(session.model?.provider, accountProviderId("work"));
  assert.equal(session.model?.id, nativeModel.id);
  assert.equal(status, "account: work");
  assert.equal(idleCalls, idleBeforeSwitch + 2);
  assert.equal(dialogs.length, 0); // no model picker when the ID is available
  assert.equal(session.sessionManager.buildSessionContext().model?.provider, accountProviderId("work"));
  // A fresh CLI startup must use the explicit /account choice, even without another login.
  const fresh = await createAgentSessionServices({
    cwd: dir, agentDir: dir,
    modelRuntime: await ModelRuntime.create({
      credentials, modelsPath: join(dir, "models.json"),
      modelsStorePath: join(dir, "models-store.json"), allowModelNetwork: false,
    }),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [accountsExtension],
    },
  });
  const { session: next } = await createAgentSessionFromServices({
    services: fresh, sessionManager: SessionManager.inMemory(dir), noTools: "all",
  });
  t.after(() => next.dispose());
  assert.equal(next.model?.provider, accountProviderId("work"));
  assert.equal(next.model?.id, nativeModel.id);
  assert.deepEqual(await saved(), {
    defaultProvider: accountProviderId("work"), defaultModel: nativeModel.id, theme: "light",
  });
  let nextStatus: string | undefined;
  await next.bindExtensions({
    mode: "tui", uiContext: {
      ...ui, setStatus(_key, text) { nextStatus = text; },
    } as ExtensionUIContext,
    commandContextActions: { async waitForIdle() {} } as ExtensionCommandContextActions,
  });
  assert.equal(nextStatus, "account: work");

  // Authentication failure and failed model changes must not publish a new account.
  const authFailure = t.mock.method(runtime, "getAuth", async () => { throw new Error("secret-token"); });
  await session.prompt("/account personal");
  authFailure.mock.restore();
  assert.equal(session.model?.provider, accountProviderId("work"));
  assert.equal(status, "account: work");
  assert.match(notifications.at(-1)!, /\/login pi-accounts-codex-personal/);
  assert(!notifications.join("\n").includes("secret-token"));
  const unavailable = t.mock.method(runtime, "hasConfiguredAuth", () => false);
  await session.prompt("/account personal");
  unavailable.mock.restore();
  assert.match(notifications.at(-1)!, /切り替えできませんでした/);
  assert.equal(status, "account: work");
  assert.equal(session.model?.provider, accountProviderId("work"));
  const failedChange = t.mock.method(session, "setModel", async () => { throw new Error("Failed change"); });
  await session.prompt("/account personal");
  failedChange.mock.restore();
  assert.equal(status, "account: work");
  assert.equal(session.model?.provider, accountProviderId("work"));
  assert.equal((await saved()).defaultProvider, accountProviderId("work"));

  // A settings failure must not undo a successful switch or be reported as an auth failure.
  const beforeFailure = await readFile(settingsPath, "utf8");
  await writeFile(settingsPath, "secret-token invalid JSON");
  await session.prompt("/account personal");
  assert.equal(session.model?.provider, accountProviderId("personal"));
  assert.equal(status, "account: personal");
  assert.match(notifications.at(-1)!, /デフォルトを保存できません/);
  assert(!notifications.join("\n").includes("secret-token"));
  assert.equal(await readFile(settingsPath, "utf8"), "secret-token invalid JSON");
  await writeFile(settingsPath, beforeFailure);
  await session.prompt("/account work");

  choices.push(undefined);
  await session.prompt("/account"); // account picker cancelled
  assert.equal(status, "account: work");
  await session.setModel({ ...nativeModel, id: "not-in-account-catalog" });
  assert.equal(status, undefined); // standard /model changes clear the account footer
  choices.push(undefined);
  await session.prompt("/account personal"); // model picker cancelled
  assert.equal(session.model?.id, "not-in-account-catalog");
  assert.equal((await saved()).defaultProvider, accountProviderId("work"));
  choices.push("personal", nativeModel.id);
  await session.prompt("/account");
  assert.equal(session.model?.provider, accountProviderId("personal"));
  assert.equal(status, "account: personal");
  assert.equal((await saved()).defaultProvider, accountProviderId("personal"));
  assert.equal(next.model?.provider, accountProviderId("work")); // No live following.
  assert.equal(nextStatus, "account: work");
  consent = false;
  await next.prompt("/account work"); // Re-selecting the current account also saves it, without consent.
  assert.equal((await saved()).defaultProvider, accountProviderId("work"));
  assert.equal(session.model?.provider, accountProviderId("personal"));
  assert.equal(status, "account: personal");
  await session.bindExtensions({ mode: "tui", uiContext: ui as ExtensionUIContext }); // session_start / reload display
  assert.equal(status, "account: personal");

  session.sessionManager.appendMessage({ role: "user", content: "Stored conversation", timestamp: 0 });
  session.dispose();
  await loader.reload();
  const { session: resumed } = await createAgentSession({
    cwd: dir, agentDir: dir, resourceLoader: loader, modelRuntime: runtime,
    noTools: "all", settingsManager: SettingsManager.create(dir, dir), sessionManager: session.sessionManager,
  });
  t.after(() => resumed.dispose());
  await resumed.bindExtensions({ mode: "print" });
  assert.equal(resumed.model?.provider, accountProviderId("personal"));
  const errors = t.mock.method(console, "error", () => {});
  await resumed.prompt("/account work");
  assert.equal(errors.mock.callCount(), 1);
  await resumed.prompt("/account add noninteractive");
  assert.equal(errors.mock.callCount(), 2);
  assert.equal(runtime.getModel(accountProviderId("noninteractive"), nativeModel.id), undefined);
  assert.equal(resumed.model?.provider, accountProviderId("personal"));
  status = undefined;
  await resumed.bindExtensions({ mode: "tui", uiContext: ui as ExtensionUIContext });
  assert.equal(status, "account: personal");
  await runtime.logout(accountProviderId("personal"));
  await resumed.prompt("/account personal");
  assert.match(notifications.at(-1)!, /\/login pi-accounts-codex-personal/);
  assert.equal(resumed.model?.provider, accountProviderId("personal")); // no fallback after logout
});

test("commands add accounts, prepare native login, switch, and safely remove without editing files or reloading", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-commands-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network access"); });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => ({
    type: "oauth", access: "native-synthetic", refresh: "synthetic", expires: Date.now() + 3_600_000,
  }));
  const runtime = await ModelRuntime.create({
    credentials, modelsPath: join(dir, "models.json"),
    modelsStorePath: join(dir, "models-store.json"), allowModelNetwork: false,
  });
  const settings = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [accountsExtension],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const nativeModel = runtime.getModels("openai-codex")[0];
  const { session, extensionsResult } = await createAgentSession({
    cwd: dir, agentDir: dir, resourceLoader: loader, modelRuntime: runtime,
    model: nativeModel, noTools: "all", settingsManager: settings, sessionManager: SessionManager.inMemory(dir),
  });
  t.after(() => session.dispose());
  let editor = "";
  let status: string | undefined;
  let consent = false;
  const notifications: string[] = [];
  const ui: Partial<ExtensionUIContext> = {
    getEditorText() { return editor; },
    setEditorText(text) { editor = text; },
    setStatus(_key, text) { status = text; },
    notify(text) { notifications.push(text); },
    async confirm() { return consent; },
  };
  await session.bindExtensions({
    mode: "tui", uiContext: ui as ExtensionUIContext,
    commandContextActions: { async waitForIdle() {} } as ExtensionCommandContextActions,
  });
  const path = join(dir, "accounts.json");
  await session.prompt("/account");
  assert.match(notifications.at(-1)!, /\/account add/);
  await session.prompt("/account add ../invalid");
  assert.match(notifications.at(-1)!, /更新できません/);
  assert.deepEqual(await readAccounts(path), []);
  assert.equal(editor, "");
  await mkdir(`${path}.lock`);
  await session.prompt("/account add locked");
  assert.match(notifications.at(-1)!, /更新できません/);
  assert.equal(runtime.getModel(accountProviderId("locked"), nativeModel.id), undefined);
  assert.deepEqual(await readAccounts(path), []);
  await rm(`${path}.lock`, { recursive: true });
  await session.prompt("/account add work");
  assert.equal(editor, "/login pi-accounts-codex-work");
  assert.deepEqual(await readAccounts(path), [{ id: "work", provider: "openai-codex" }]);
  assert(runtime.getModel(accountProviderId("work"), nativeModel.id));
  assert.equal(session.model?.provider, "openai-codex"); // Adding does not send the conversation elsewhere.
  assert.equal(session.state.messages.length, 0); // Built-in /login must never be sent as an LLM prompt.
  await session.prompt("/account add work");
  assert.match(notifications.at(-1)!, /登録済み/);
  const command = extensionsResult.extensions[0].commands.get("account")!;
  assert.deepEqual(await command.getArgumentCompletions!("remove w"), [{ value: "remove work", label: "remove work" }]);

  editor = "unfinished draft";
  await session.prompt("/account work"); // Login guidance does not overwrite drafts.
  assert.equal(editor, "unfinished draft");
  editor = "";
  await session.prompt("/account work");
  assert.equal(editor, "/login pi-accounts-codex-work");

  // Simulate Pi's built-in login using synthetic credentials, not an external OAuth flow.
  const provider = runtime.getProvider(accountProviderId("work"))!;
  runtime.registerNativeProvider({ ...provider, auth: { oauth: {
    ...provider.auth.oauth!,
    async login() { return { type: "oauth", access: "synthetic", refresh: "synthetic", expires: Date.now() + 3_600_000 }; },
  } } });
  await runtime.login(provider.id, "oauth", { async prompt() { return ""; }, notify() {} });
  await session.prompt("/account work"); // No consent yet.
  assert.equal(session.model?.provider, "openai-codex");
  consent = true;
  await session.prompt("/account work");
  assert.equal(session.model?.provider, provider.id);
  assert.equal(status, "account: work");
  await session.prompt("/account remove work");
  assert.match(notifications.at(-1)!, /先に/);
  await session.setModel(nativeModel);
  await session.prompt("/account remove work");
  assert.match(notifications.at(-1)!, /\/logout/);
  await runtime.logout(provider.id);
  consent = false;
  await session.prompt("/account remove work");
  assert.equal((await readAccounts(path)).length, 1);
  consent = true;
  await session.prompt("/account remove work");
  assert.deepEqual(await readAccounts(path), []);
  assert.equal(runtime.getModel(provider.id, nativeModel.id), undefined);
  await session.prompt("/account remove missing");
  assert.match(notifications.at(-1)!, /未登録/);

  // Another session's additions survive; command words remain valid existing account names.
  await updateAccounts(path, "add", "add");
  await session.prompt("/account add personal");
  assert.deepEqual((await readAccounts(path)).map((account) => account.id), ["add", "personal"]);
  assert(runtime.getModel(accountProviderId("add"), nativeModel.id));
  editor = "";
  await session.prompt("/account add");
  assert.equal(editor, "/login pi-accounts-codex-add");

  await writeFile(path, "secret-token invalid JSON");
  await session.prompt("/account add blocked");
  assert.equal(runtime.getModel(accountProviderId("blocked"), nativeModel.id), undefined);
  assert(!notifications.join("\n").includes("secret-token"));
});
