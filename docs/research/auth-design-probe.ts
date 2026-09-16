import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Offline research check: only synthetic credentials, under an isolated agent dir.
export default function (pi: ExtensionAPI) {
  pi.registerCommand("auth-design-probe", {
    description: "Verify account alias credential isolation without network access",
    async handler(_args, ctx) {
      const dir = process.env.PI_CODING_AGENT_DIR!;
      const authPath = join(dir, "probe-auth.json");
      const runtime = await ModelRuntime.create({
        authPath,
        modelsPath: join(dir, "probe-models.json"),
        modelsStorePath: join(dir, "probe-models-store.json"),
        allowModelNetwork: false,
      });
      const registry = new ModelRegistry(runtime);
      assert.equal("authStorage" in registry, false);
      assert.equal("modelRuntime" in ctx, false);
      assert.throws(() => Reflect.get(registry, "authStorage").set("openai-codex", {}), TypeError);

      const base = builtinProviders().find(p => p.id === "openai-codex")!;
      assert(base.auth.oauth);
      const refreshed: string[] = [];
      for (const account of ["work", "personal"]) {
        const id = `openai-codex-${account}`;
        const alias = {
          ...base,
          id,
          name: `Codex ${account}`,
          getModels: () => base.getModels().map(model => ({ ...model, provider: id })),
          auth: {
            oauth: {
              ...base.auth.oauth,
              async login() {
                return { type: "oauth" as const, access: `${account}-old`, refresh: `${account}-r1`, expires: 0 };
              },
              async refresh(credential: OAuthCredential) {
                assert.equal(credential.refresh, `${account}-r1`);
                refreshed.push(account);
                return { ...credential, access: `${account}-new`, refresh: `${account}-r2`, expires: Date.now() + 3_600_000 };
              },
              async toAuth(credential: OAuthCredential) {
                return { apiKey: credential.access, headers: { "x-test-account": account } };
              },
            },
          },
        };
        pi.registerProvider(alias);
        runtime.registerNativeProvider(alias);
        await runtime.login(id, "oauth", {
          async prompt() { throw new Error("Unexpected login interaction"); },
          notify() {},
        });
      }
      await ctx.modelRegistry.refresh({ allowNetwork: false });
      assert(ctx.modelRegistry.find("openai-codex-work", base.getModels()[0].id));
      const [work1, work2, personal] = await Promise.all([
        runtime.getAuth("openai-codex-work"),
        runtime.getAuth("openai-codex-work"),
        runtime.getAuth("openai-codex-personal"),
      ]);
      assert.equal(work1?.auth.apiKey, "work-new");
      assert.equal(work2?.auth.apiKey, "work-new");
      assert.equal(personal?.auth.apiKey, "personal-new");
      assert.deepEqual(refreshed.sort(), ["personal", "work"]);
      const saved = JSON.parse(await readFile(authPath, "utf8"));
      assert.equal(saved["openai-codex-work"].refresh, "work-r2");
      assert.equal(saved["openai-codex-personal"].refresh, "personal-r2");
      assert.equal(saved["openai-codex"], undefined);
      assert(registry.getAvailable().some(model => model.provider === "openai-codex-work"));
      assert(registry.getAvailable().some(model => model.provider === "openai-codex-personal"));
      console.log("PASS: removed API reproduced; native aliases registered; independent login/refresh persistence; same-account refresh serialized.");
    },
  });
}
