import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = process.argv[2];
const root = mkdtempSync(join(tmpdir(), "clai-migration-smoke-"));
const history = join(root, "history");
mkdirSync(history, { recursive: true });
const record = (id, turns, text) => ({
  id,
  name: id,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: `2026-01-0${turns > 10 ? 2 : 1}T00:00:00.000Z`,
  cwd: root,
  revision: 1,
  writerGeneration: "0001-legacy",
  messages: Array.from({ length: turns }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `${text} ${index}` })),
  transcript: Array.from({ length: turns }, (_, index) => ({ kind: index % 2 ? "assistant" : "user", id: `${id}-${index}`, text: `${text} ${index}`, done: true })),
});
const sessions = [record("legacy-small", 4, "日本語 🧪 \"quoted\""), record("legacy-large", 1000, "turn")];
const legacyPath = join(history, "history.jsonl");
writeFileSync(legacyPath, sessions.map((session) => JSON.stringify(session)).join("\n") + "\n");
const digest = () => createHash("sha256").update(readFileSync(legacyPath)).digest("hex");
const before = digest();
const env = {
  ...process.env,
  CLAI_HISTORY_DIR: history,
  CLAI_DATA_DIR: join(root, "data"),
  CLAI_CONFIG_DIR: join(root, "config"),
  CLAI_NO_UPDATE_CHECK: "1",
  CLAI_DISABLE_KEYCHAIN: "1",
  CLAI_OFFLINE: "1",
  CLAI_DISABLE_SESSION_RUNTIME: "1",
};
const run = (...args) => execFileSync(binary, args, { env, encoding: "utf8", timeout: 60_000 });
const listing = run("history");
for (const session of sessions) if (!listing.includes(session.id)) throw new Error(`history listing is missing ${session.id}:\n${listing}`);
for (const session of sessions) {
  const shown = JSON.parse(run("history", "--show", session.id));
  const contents = (list) => JSON.stringify(list.map((entry) => entry.content ?? entry.text));
  if (contents(shown.messages) !== contents(session.messages)) throw new Error(`messages differ for ${session.id}`);
  if (contents(shown.transcript) !== contents(session.transcript)) throw new Error(`transcript differs for ${session.id}`);
}
if (digest() !== before) throw new Error("history.jsonl was modified");
const sessionsDir = join(history, "sessions");
if (!existsSync(join(sessionsDir, "index.json"))) throw new Error("sessions/index.json missing");
const keys = readdirSync(sessionsDir).filter((name) => /^[0-9a-f]{64}$/.test(name));
if (keys.length !== sessions.length) throw new Error(`expected ${sessions.length} session logs, found ${keys.length}`);
console.log(`migration smoke passed on ${process.platform}: ${keys.length} sessions migrated, legacy file untouched`);
