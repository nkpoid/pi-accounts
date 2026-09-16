import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AssistantMessage, Context, OAuthCredential } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { accountProviderId, createCodexAccountProvider } from "../src/codex.ts";

const work = createCodexAccountProvider("work");
const personal = createCodexAccountProvider("personal");
const model = work.getModels()[0];
const token = `test.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-work" },
})).toString("base64url")}.test`;
const usage: AssistantMessage["usage"] = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("native serializer preserves same-account replay and sanitizes foreign-account history", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network access"); });
  const callId = "call_original|fc_original";
  for (const source of [work.id, personal.id, "openai-codex", "anthropic"]) {
    const history: Context = { messages: [
      { role: "user", content: "Run a tool", timestamp: 0 },
      {
        role: "assistant", provider: source, api: model.api, model: model.id,
        timestamp: 0, stopReason: "toolUse", usage,
        content: [
          { type: "thinking", thinking: "", thinkingSignature: JSON.stringify({
            id: "rs_private", type: "reasoning", encrypted_content: "private", summary: [],
          }) },
          { type: "text", text: "Running", textSignature: "msg_private" },
          { type: "toolCall", id: callId, name: "read", arguments: { path: "file" } },
        ],
      },
      {
        role: "toolResult", toolCallId: callId, toolName: "read",
        content: [{ type: "text", text: "contents" }], isError: false, timestamp: 0,
      },
    ] };
    const original = structuredClone(history);
    for (const stream of [work.stream, work.streamSimple]) {
      let input: Record<string, unknown>[] = [];
      const result = await stream(model, history, {
        apiKey: token,
        onPayload(payload, selected) {
          assert.equal(selected.provider, work.id);
          input = (payload as { input: Record<string, unknown>[] }).input;
          throw new Error("Payload captured before network");
        },
      }).result();
      assert.match(result.errorMessage!, /Payload captured/);
      assert.equal(result.provider, work.id);
      const call = input.find((item) => item.type === "function_call")!;
      const output = input.find((item) => item.type === "function_call_output")!;
      assert.equal(call.call_id, "call_original");
      assert.equal(output.call_id, call.call_id);
      assert.equal(input.some((item) => item.type === "reasoning"), source === work.id);
      assert.equal(input.some((item) => item.id === "msg_private"), source === work.id);
      if (source === work.id) assert.equal(call.id, "fc_original");
      else assert.notEqual(call.id, "fc_original");
      assert.deepEqual(history, original);
    }
  }
});

test("native SSE output, callbacks, and errors retain the account provider", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.equal(headers.get("chatgpt-account-id"), "synthetic-work");
    return new Response(`data: ${JSON.stringify({
      type: "response.completed", response: { status: "completed", output: [] },
    })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  let responded = false;
  const stream = work.streamSimple(model, { messages: [] }, {
    apiKey: token, transport: "sse", reasoning: "high",
    onPayload(payload) {
      assert.equal((payload as { reasoning: { effort: string } }).reasoning.effort, "high");
    },
    onResponse(_response, selected) {
      assert.equal(selected.provider, work.id);
      responded = true;
    },
  });
  const events = [];
  for await (const event of stream) {
    events.push(event.type);
    const message = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
    assert.equal(message.provider, work.id);
  }
  assert.deepEqual(events, ["start", "done"]);
  assert.equal((await stream.result()).stopReason, "stop");
  assert(responded);
  const failed = await work.streamSimple(model, { messages: [] }).result();
  assert.equal(failed.provider, work.id);
  assert.equal(failed.stopReason, "error");
});

test("Pi owns independent login, refresh persistence, logout, and failure isolation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-auth-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network access"); });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"),
    modelsStorePath: join(dir, "models-store.json"), allowModelNetwork: false,
  });
  const refreshed: string[] = [];
  for (const id of ["work", "personal"]) {
    const provider = createCodexAccountProvider(id);
    assert.equal(provider.auth.apiKey, undefined);
    runtime.registerNativeProvider({
      ...provider,
      auth: { oauth: {
        ...provider.auth.oauth!,
        async login() {
          return { type: "oauth", access: `${id}-old`, refresh: `${id}-r1`, expires: 0 };
        },
        async refresh(credential: OAuthCredential) {
          assert.equal(credential.refresh, `${id}-r1`);
          refreshed.push(id);
          return { ...credential, access: `${id}-new`, refresh: `${id}-r2`, expires: Date.now() + 3_600_000 };
        },
        async toAuth(credential: OAuthCredential) { return { apiKey: credential.access }; },
      } },
    });
    await runtime.login(provider.id, "oauth", {
      async prompt() { throw new Error("Unexpected prompt"); }, notify() {},
    });
  }
  const [first, second, other] = await Promise.all([
    runtime.getAuth(work.id), runtime.getAuth(work.id), runtime.getAuth(personal.id),
  ]);
  assert.equal(first?.auth.apiKey, "work-new");
  assert.equal(second?.auth.apiKey, "work-new");
  assert.equal(other?.auth.apiKey, "personal-new");
  assert.deepEqual(refreshed.sort(), ["personal", "work"]);
  const saved = JSON.parse(await readFile(join(dir, "auth.json"), "utf8"));
  assert.equal(saved[work.id].refresh, "work-r2");
  assert.equal(saved[personal.id].refresh, "personal-r2");
  assert.equal(saved["openai-codex"], undefined);
  await runtime.logout(work.id);
  assert.equal(await runtime.getAuth(work.id), undefined);
  assert.equal((await runtime.getAuth(personal.id))?.auth.apiKey, "personal-new");

  const broken = createCodexAccountProvider("expired");
  runtime.registerNativeProvider({ ...broken, auth: { oauth: {
    ...broken.auth.oauth!,
    async login() { return { type: "oauth", access: "old", refresh: "keep", expires: 0 }; },
    async refresh() { throw new Error("Re-login required"); },
  } } });
  await runtime.login(broken.id, "oauth", { async prompt() { return ""; }, notify() {} });
  await assert.rejects(runtime.getAuth(broken.id), /Re-login required/);
  const afterFailure = JSON.parse(await readFile(join(dir, "auth.json"), "utf8"));
  assert.equal(afterFailure[accountProviderId("expired")].refresh, "keep");
  assert.equal((await runtime.getAuth(personal.id))?.auth.apiKey, "personal-new");
});
