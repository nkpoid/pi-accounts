import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readAccounts, updateAccounts } from "../src/accounts.ts";

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

test("account updates preserve existing settings and fail closed without partial writes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-update-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "agent", "accounts.json");
  await updateAccounts(path, "add", "work");
  await updateAccounts(path, "add", "personal");
  assert.deepEqual(await readAccounts(path), [
    { id: "work", provider: "openai-codex" },
    { id: "personal", provider: "openai-codex" },
  ]);
  const original = await readFile(path, "utf8");
  for (const id of ["work", "../work", "", "A", "x".repeat(65), "secret-token\u001b"]) {
    await assert.rejects(updateAccounts(path, "add", id), (error: Error) => !error.message.includes("secret-token"));
    assert.equal(await readFile(path, "utf8"), original);
  }
  await assert.rejects(updateAccounts(path, "remove", "missing"), /未登録/);
  await mkdir(`${path}.lock`);
  await assert.rejects(updateAccounts(path, "add", "blocked"), { code: "EEXIST" });
  assert.deepEqual(await readdir(`${path}.lock`), []); // Never remove another writer's lock.
  assert.equal(await readFile(path, "utf8"), original);
  await rm(`${path}.lock`, { recursive: true });

  const results = await Promise.allSettled(["one", "two"].map((id) => updateAccounts(path, "add", id)));
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") await updateAccounts(path, "add", ["one", "two"][index]);
  }
  assert.deepEqual((await readAccounts(path)).map((account) => account.id).sort(), ["one", "personal", "two", "work"]);
  await updateAccounts(path, "remove", "work");
  assert.deepEqual((await readAccounts(path)).map((account) => account.id).sort(), ["one", "personal", "two"]);
  await writeFile(path, "secret-token invalid JSON");
  await assert.rejects(updateAccounts(path, "add", "new"), (error: Error) => !error.message.includes("secret-token"));
  assert.equal(await readFile(path, "utf8"), "secret-token invalid JSON");
  assert.deepEqual(await readdir(join(dir, "agent")), ["accounts.json"]);
});
