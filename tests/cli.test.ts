import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("Pi loads the provider without extension-local node_modules", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(new URL("../src/codex.ts", import.meta.url), join(dir, "codex.ts"));
  await writeFile(join(dir, "probe.ts"), `
    import assert from "node:assert/strict";
    import { createCodexAccountProvider } from "./codex.ts";
    export default function (pi) {
      const provider = createCodexAccountProvider("work");
      pi.registerProvider(provider);
      pi.registerCommand("probe", { async handler(_args, ctx) {
        const model = provider.getModels()[0];
        assert(ctx.modelRegistry.find(provider.id, model.id));
        const result = await provider.streamSimple(model, { messages: [] }).result();
        assert.equal(result.provider, provider.id);
        assert.equal(result.stopReason, "error");
        console.log("PASS: isolated provider loaded");
      } });
    }
  `);
  const result = spawnSync(process.execPath, [
    resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    "-p", "--no-session", "--no-context-files", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-themes", "--no-tools", "--no-approve", "-e", "./probe.ts", "/probe",
  ], {
    cwd: dir, encoding: "utf8", timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout + result.stderr, /PASS: isolated provider loaded/);
});
