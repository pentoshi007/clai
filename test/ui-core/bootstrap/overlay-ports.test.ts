import { describe, expect, it } from "vitest";
import { FocusController } from "../../../src/ui-core/controllers/focus-controller.js";
import { OverlayController } from "../../../src/ui-core/controllers/overlay-controller.js";
import { createOverlayConfirmPort, createOverlaySecretPort } from "../../../src/ui-core/bootstrap/overlay-ports.js";

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
      expect(state.request.review?.body).toContain("rm -rf /tmp/x");
    }
    overlay.answerConfirm(true);
    expect(await pending).toBe(true);
  });

  it("confirmPentest and confirmAgentSwitch produce the expected prompts", async () => {
    const overlay = new OverlayController(new FocusController());
    const port = createOverlayConfirmPort(overlay);

    const pentest = port.confirmPentest({
      name: "shell.exec",
      args: { command: "nmap -sV 10.0.0.1" },
    });
    const pentestState = overlay.getState();
    expect(pentestState.kind).toBe("confirm");
    if (pentestState.kind === "confirm") {
      expect(pentestState.request.review?.body).toContain("nmap -sV 10.0.0.1");
    }
    overlay.answerConfirm(false);
    expect(await pentest).toBe(false);

    const switchPromise = port.confirmAgentSwitch!({ reason: "needs a shell", tools: ["shell.exec"] });
    const switchState = overlay.getState();
    if (switchState.kind === "confirm") {
      expect(switchState.request.prompt).toContain("needs a shell");
      expect(switchState.request.prompt).toContain("shell.exec");
    }
    overlay.answerConfirm(true);
    expect(await switchPromise).toBe(true);
  });

  it("keeps the complete command and permission reason available in operation review", async () => {
    const overlay = new OverlayController(new FocusController());
    const port = createOverlayConfirmPort(overlay);
    const command = `node <<'NODE'\n${"  console.log('test');\n".repeat(300)}LAST_COMMAND_LINE\nNODE`;
    const reason = "Auto-allow cannot verify the deletion target.";
    const answer = port.confirmTool({ name: "shell.exec", args: { command } }, { reason });
    const state = overlay.getState();
    if (state.kind !== "confirm") throw new Error("expected confirmation");
    expect(state.request.reason).toBe(reason);
    overlay.openOperationReview();
    const pager = overlay.getState();
    if (pager.kind !== "pager") throw new Error("expected operation review");
    expect(pager.body).toContain(`Reason: ${reason}`);
    expect(pager.body).toContain(command);
    overlay.close();
    expect(overlay.getState()).toBe(state);
    overlay.answerConfirm(false);
    await expect(answer).resolves.toBe(false);
  });

  it("secret port resolves the entered value and undefined on cancel", async () => {
    const overlay = new OverlayController(new FocusController());
    const request = createOverlaySecretPort(overlay);

    const pending = request({
      title: "Administrator access",
      prompt: "enter it",
      operation: { name: "shell.exec", args: { command: "sudo apt update" } },
    });
    const state = overlay.getState();
    expect(state.kind).toBe("secret");
    if (state.kind === "secret") {
      expect(state.request.review?.body).toContain("sudo apt update");
    }
    overlay.answerSecret("sk-abc");
    expect(await pending).toBe("sk-abc");

    const cancelled = request({ title: "t", prompt: "p" });
    overlay.answerSecret(undefined);
    expect(await cancelled).toBeUndefined();
  });
});
