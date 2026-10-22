import { SessionController } from "../../src/app/controllers/session-controller.js";
import { createCurrentPersistencePort } from "../../src/app/adapters/current-store-adapter.js";
import { getProvider } from "../../src/llm/router.js";

getProvider("free").listModels = async () => [];
const session = new SessionController({
  sessionId: "queue-crash-fixture", provider: "free", model: "fixture-model", emit() {},
  persistence: { ...createCurrentPersistencePort(), async saveSession() {} },
  agent: { reportsModelSubmission: true, runTurn: async () => new Promise(() => undefined) },
});
session.enqueue("survives abrupt termination");
session.sendQueuedNow(0);
process.kill(process.pid, "SIGKILL");
