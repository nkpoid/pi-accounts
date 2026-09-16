import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readAccounts } from "../src/accounts.ts";

test("account configuration accepts only unique IDs and Codex providers, never echoes secrets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "accounts.json");
  assert.deepEqual(await readAccounts(path), []);
  const account = { id: "work_1-team", provider: "openai-codex" };
  await writeFile(path, JSON.stringify([account]));
  assert.deepEqual(await readAccounts(path), [account]);
  for (const data of [
    {}, null, [null], [account, account], [{ ...account, provider: "anthropic" }],
    [{ ...account, id: "../work" }], [{ ...account, id: "" }], [{ ...account, id: "A" }],
    [{ ...account, id: "x".repeat(65) }], [{ ...account, id: "work\u001b[31m" }],
    [{ ...account, label: "work" }], [{ ...account, access: "secret-token" }],
  ]) {
    await writeFile(path, JSON.stringify(data));
    await assert.rejects(readAccounts(path), (error: Error) => {
      assert(!error.message.includes("secret-token"));
      return /pi-accounts:/.test(error.message);
    });
  }
  await writeFile(path, "secret-token invalid JSON");
  await assert.rejects(readAccounts(path), (error: Error) => !error.message.includes("secret-token"));
  await assert.rejects(readAccounts(dir), /読み込めません/);
});
