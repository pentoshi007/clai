import { mkdir, appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ChatMessage } from "../types.js";
import { redactSecrets } from "../llm/provider.js";

const historyDir = join(homedir(), ".clai");
const historyFile = join(historyDir, "history.jsonl");

export interface HistoryRecord {
  id: string;
  name?: string | undefined;
  createdAt: string;
  cwd: string;
  messages: ChatMessage[];
}

export async function saveSession(
  messages: ChatMessage[],
  name?: string | undefined,
): Promise<HistoryRecord> {
  await mkdir(historyDir, { recursive: true });
  const record: HistoryRecord = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    createdAt: new Date().toISOString(),
    cwd: process.cwd(),
    messages: messages.map((message) => ({
      ...message,
      content: redactSecrets(message.content),
    })),
  };
  await appendFile(historyFile, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export async function listSessions(limit = 20): Promise<HistoryRecord[]> {
  if (!existsSync(historyFile)) {
    return [];
  }
  const raw = await readFile(historyFile, "utf8");
  const rows = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HistoryRecord);
  return rows.slice(-limit).reverse();
}

export function getHistoryPath(): string {
  return historyFile;
}
