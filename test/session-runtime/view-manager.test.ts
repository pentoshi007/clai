import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompositionRoot, type AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import type { AgentPort, RunTurnHandlers, RunTurnRequest } from "../../src/app/ports/agent-port.js";
import { RuntimeViewManager } from "../../src/session-runtime/view-manager.js";
import type { RuntimeViewTerminal } from "../../src/session-runtime/view-terminal.js";
import { handleNew } from "../../src/ui-core/commands/session-commands.js";

vi.mock("../../src/app/controllers/session-naming.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/app/controllers/session-naming.js")>(),
  completeForSessionNaming: vi.fn(async () => "TITLE: Independent terminal views"),
}));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((dispose) => dispose())); });

function fixture(agent?: AgentPort) {
  const bridge = { writeView: vi.fn(() => true), closeView: vi.fn(() => true), minimise: vi.fn(() => true), switchSession: vi.fn(() => true) };
  const mounted: Array<{ services: AppServices; terminal: RuntimeViewTerminal; input: Buffer[]; dispose: ReturnType<typeof vi.fn> }> = [];
  const manager = new RuntimeViewManager(bridge, async (services, terminal) => {
    const input: Buffer[] = [];
    terminal.stdin.on("data", (bytes: Buffer) => input.push(Buffer.from(bytes)));
    const dispose = vi.fn(async () => {});
    mounted.push({ services, terminal, input, dispose });
    return { repaint: () => true, dispose };
  });
  const run = vi.fn(async (_request: RunTurnRequest, handlers: RunTurnHandlers) => {
    handlers.onEvent({ type: "assistant-delta", text: "shared answer" });
    return createTurnOutcome({ status: "succeeded", answer: "shared answer", steps: 0, remainingCriteria: [] });
  });
  const shared = createCompositionRoot({
    agent: agent ?? { runTurn: run }, provider: "ollama", model: "fixture",
    confirm: manager.confirm, requestSecret: manager.requestSecret,
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  });
  manager.bind(shared);
  cleanup.push(async () => { await manager.dispose(); shared.dispose(); });
  const attach = (id: string, columns = 120, rows = 40): void => manager.receive({ type: "view-attach", clientId: id, columns, rows, terminal: { ui: "classic", env: { TERM: "xterm-256color" } } });
  return { bridge, manager, shared, mounted, attach, run };
}

describe("independent attachment views", () => {
  it("routes input and resize to one device and keeps the other view intact", async () => {
    const f = fixture();
    f.attach("desktop");
    f.attach("phone", 38, 20);
    await vi.waitFor(() => expect(f.mounted).toHaveLength(2));
    const [desktop, phone] = f.mounted;
    const resized = vi.fn();
    desktop!.terminal.stdout.on("resize", resized);
    f.manager.receive({ type: "view-input", clientId: "phone", data: Buffer.from("private draft_界_🙂").toString("base64") });
    await vi.waitFor(() => expect(phone!.input).toHaveLength(1));
    expect(Buffer.concat(phone!.input).toString()).toBe("private draft_界_🙂");
    expect(desktop!.input).toEqual([]);
    f.manager.receive({ type: "view-resize", clientId: "phone", columns: 28, rows: 12 });
    expect(phone!.terminal.stdout.columns).toBe(28);
    expect(phone!.terminal.stdout.rows).toBe(12);
    expect(desktop!.terminal.stdout.columns).toBe(120);
    expect(desktop!.terminal.stdout.rows).toBe(40);
    expect(resized).not.toHaveBeenCalled();
    desktop!.services.overlay.openPager("desktop only", "private pager");
    expect(phone!.services.overlay.isOpen()).toBe(false);
    expect(desktop!.services.focus).not.toBe(phone!.services.focus);
  });

  it("shares one agent and its transcript while detach disposes only the calling view", async () => {
    const f = fixture();
    f.attach("desktop");
    f.attach("phone", 38, 20);
    await vi.waitFor(() => expect(f.mounted).toHaveLength(2));
    const [desktop, phone] = f.mounted;
    await desktop!.services.session.submit("one shared request");
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(phone!.services.session.messages).toBe(f.shared.session.messages);
    expect(phone!.services.transcript.getState().byId).toBe(f.shared.transcript.getState().byId);
    const dispose = vi.spyOn(f.shared, "dispose");
    await f.manager.detach("desktop");
    expect(desktop!.dispose).toHaveBeenCalledTimes(1);
    expect(phone!.dispose).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    await phone!.services.session.submit("continue from phone");
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it("tags minimise and session switches with the caller even after another device types", async () => {
    const f = fixture();
    f.attach("desktop");
    f.attach("phone", 38, 20);
    await vi.waitFor(() => expect(f.mounted).toHaveLength(2));
    const [desktop] = f.mounted;
    f.manager.receive({ type: "view-input", clientId: "phone", data: Buffer.from("other input").toString("base64") });
    desktop!.services.requestMinimise();
    expect(f.bridge.minimise).toHaveBeenCalledWith("desktop");
    desktop!.services.requestSessionSwitch("another-session", false, true);
    expect(f.bridge.switchSession).toHaveBeenCalledWith("another-session", false, true, "desktop");
    const id = f.shared.session.sessionId;
    await handleNew(desktop!.services);
    expect(f.shared.session.sessionId).toBe(id);
    expect(f.bridge.switchSession).toHaveBeenLastCalledWith(expect.any(String), false, true, "desktop");
  });

  it("moves a pending confirmation to another attachment after the requesting device disconnects", async () => {
    const f = fixture();
    f.attach("desktop");
    f.attach("phone", 38, 20);
    await vi.waitFor(() => expect(f.mounted).toHaveLength(2));
    const [desktop, phone] = f.mounted;
    const answer = f.manager.ask((view) => view.overlay.openConfirm({ kind: "tool", prompt: "Approve shared work?" }), false);
    await vi.waitFor(() => expect(phone!.services.overlay.getState().kind).toBe("confirm"));
    await f.manager.detach("phone");
    await vi.waitFor(() => expect(desktop!.services.overlay.getState().kind).toBe("confirm"));
    desktop!.services.overlay.answerConfirm(true);
    await expect(answer).resolves.toBe(true);
  });

  it("keeps asynchronous agent confirmations on the terminal that submitted the turn", async () => {
    const agent: AgentPort = { async runTurn(_request, handlers) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const approved = await handlers.confirm!.confirmAgentSwitch!({ reason: "Review shared work", tools: ["fs.read"] });
      expect(approved).toBe(true);
      return createTurnOutcome({ status: "succeeded", answer: "approved", steps: 0, remainingCriteria: [] });
    } };
    const f = fixture(agent);
    f.attach("desktop");
    f.attach("phone");
    await vi.waitFor(() => expect(f.mounted).toHaveLength(2));
    const [desktop, phone] = f.mounted;
    const turn = desktop!.services.session.submit("review this work");
    f.manager.receive({ type: "view-input", clientId: "phone", data: Buffer.from("another private draft").toString("base64") });
    await vi.waitFor(() => expect(desktop!.services.overlay.getState().kind).toBe("confirm"));
    expect(phone!.services.overlay.isOpen()).toBe(false);
    desktop!.services.overlay.answerConfirm(true);
    await turn;
  });

  it("keeps unanswered requests pending across zero attachments and cancels them on shutdown", async () => {
    const f = fixture();
    let settled = false;
    const answer = f.manager.ask((view) => view.overlay.openConfirm({ kind: "tool", prompt: "Approve?" }), false).then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    f.attach("phone", 38, 20);
    await vi.waitFor(() => expect(f.mounted[0]?.services.overlay.getState().kind).toBe("confirm"));
    await f.manager.dispose();
    await expect(answer).resolves.toBe(false);
  });

  it("preserves ordered buffered Unicode input while a renderer is starting", async () => {
    const f = fixture();
    f.attach("phone", 38, 20);
    const input = Buffer.from("retained_界_🙂\n".repeat(10_000));
    for (let offset = 0; offset < input.length; offset += 32 * 1024) f.manager.receive({ type: "view-input", clientId: "phone", data: input.subarray(offset, offset + 32 * 1024).toString("base64") });
    await vi.waitFor(() => expect(Buffer.concat(f.mounted[0]!.input)).toEqual(input));
    expect(f.bridge.closeView).not.toHaveBeenCalled();
  });

  it("dismisses shared notices in every view while preserving private notices", async () => {
    const f = fixture();
    f.attach("desktop");
    f.attach("phone");
    await vi.waitFor(() => expect(f.mounted).toHaveLength(2));
    const [desktop, phone] = f.mounted;
    const id = f.shared.toast.show("Shared work waiting", { sticky: true, key: "waiting" });
    desktop!.services.toast.show("Private desktop notice", { sticky: true });
    expect(phone!.services.toast.getToasts().map((toast) => toast.message)).toEqual(["Shared work waiting"]);
    f.shared.toast.dismiss(id);
    expect(phone!.services.toast.getToasts()).toEqual([]);
    expect(desktop!.services.toast.getToasts().map((toast) => toast.message)).toEqual(["Private desktop notice"]);
  });

  it("waits for an already detached renderer before completing backend shutdown", async () => {
    const f = fixture();
    f.attach("desktop");
    await vi.waitFor(() => expect(f.mounted).toHaveLength(1));
    let finish: () => void;
    const destroyed = new Promise<void>((resolve) => { finish = resolve; });
    f.mounted[0]!.dispose.mockImplementation(() => destroyed);
    const detached = f.manager.detach("desktop");
    const shutdown = f.manager.dispose();
    let completed = false;
    void shutdown.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(f.manager.dispose()).toBe(shutdown);
    finish!();
    await Promise.all([detached, shutdown]);
    expect(completed).toBe(true);
  });
});
