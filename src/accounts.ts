import { readFile } from "node:fs/promises";

export type Account = { id: string; provider: "openai-codex" };

export async function readAccounts(path: string): Promise<Account[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw new Error(`pi-accounts: ${path} を読み込めません。`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // Do not echo JSON parse errors: a misplaced credential could be in the input.
    throw new Error(`pi-accounts: ${path} は有効な JSON ではありません。`);
  }
  return validateAccounts(data, path);
}

function validateAccounts(data: unknown, path: string): Account[] {
  if (!Array.isArray(data)) throw new Error(`pi-accounts: ${path} は配列で指定してください。`);
  const ids = new Set<string>();
  return data.map((entry: unknown, index) => {
    if (!entry || typeof entry !== "object" || !("id" in entry) || !("provider" in entry)
      || typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.id)
      || entry.provider !== "openai-codex"
      || Object.keys(entry).some((key) => key !== "id" && key !== "provider")) {
      throw new Error(`pi-accounts: ${path} の ${index + 1} 件目は不正です。id（半角小文字英数字、_、-、1〜64文字）と provider: openai-codex のみ指定してください。`);
    }
    if (ids.has(entry.id)) throw new Error(`pi-accounts: ${path} の ${index + 1} 件目の id が重複しています。`);
    ids.add(entry.id);
    return { id: entry.id, provider: entry.provider };
  });
}
