import { describe, expect, it } from "vitest";
import { FocusController } from "../../../src/tui-v2/controllers/focus-controller.js";
import { OverlayController } from "../../../src/tui-v2/controllers/overlay-controller.js";
import { createOverlayConfirmPort, createOverlaySecretPort } from "../../../src/tui-v2/bootstrap/overlay-ports.js";

describe("overlay-backed confirm/secret ports (CORE-002, V2-073)", () => {
  it("confirmTool describes a shell.exec call and resolves on answer", async () => {
    const overlay = new OverlayController(new FocusController());
    const port = createOverlayConfirmPort(overlay);

    const pending = port.confirmTool({ name: "shell.exec", args: { command: "rm -rf /tmp/x" } });
    const state = overlay.getState();
    expect(state.kind).toBe("confirm");
    if (state.kind === "confirm") {
      expect(state.request.kind).toBe("tool");
      expect(state.request.prompt).toBe("Run shell.exec rm -rf /tmp/x?");
    }
    overlay.answerConfirm(true);
    expect(await pending).toBe(true);
  });

  it("confirmPentest, confirmContinue, and confirmAgentSwitch produce the expected prompts", async () => {
    const overlay = new OverlayController(new FocusController());
    const port = createOverlayConfirmPort(overlay);

    const pentest = port.confirmPentest();
    expect(overlay.getState().kind).toBe("confirm");
    overlay.answerConfirm(false);
    expect(await pentest).toBe(false);

    const cont = port.confirmContinue(70);
    const contState = overlay.getState();
    if (contState.kind === "confirm") expect(contState.request.prompt).toContain("70 steps");
    overlay.answerConfirm(true);
    expect(await cont).toBe(true);

    const switchPromise = port.confirmAgentSwitch!({ reason: "needs a shell", tools: ["shell.exec"] });
    const switchState = overlay.getState();
    if (switchState.kind === "confirm") {
      expect(switchState.request.prompt).toContain("needs a shell");
      expect(switchState.request.prompt).toContain("shell.exec");
    }
    overlay.answerConfirm(true);
    expect(await switchPromise).toBe(true);
  });

  it("secret port resolves the entered value and undefined on cancel", async () => {
    const overlay = new OverlayController(new FocusController());
    const request = createOverlaySecretPort(overlay);

    const pending = request({ title: "groq API key", prompt: "enter it" });
    expect(overlay.getState().kind).toBe("secret");
    overlay.answerSecret("sk-abc");
    expect(await pending).toBe("sk-abc");

    const cancelled = request({ title: "t", prompt: "p" });
    overlay.answerSecret(undefined);
    expect(await cancelled).toBeUndefined();
  });
});
