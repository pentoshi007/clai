import { AgentEventAdapter } from "../../src/app/adapters/agent-event-adapter.js";
import { asSessionId, asTurnId } from "../../src/app/events/app-event.js";
import { createCountingIdFactory, EventSequencer } from "../../src/app/events/sequencer.js";
import type { BackgroundJob, JobManagerListener, JobsPort } from "../../src/app/ports/jobs-port.js";
import type { AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { transcriptItems } from "../../src/ui-core/state/transcript-types.js";
import { createJobsPort, job } from "../classic/panels/harness.js";

export function liveTool(services: AppServices) {
  const adapter = new AgentEventAdapter(
    new EventSequencer(asSessionId(services.session.sessionId), createCountingIdFactory()),
    services.session.spool,
    (event) => services.transcript.dispatch(event),
  );
  adapter.setTurn(asTurnId("live-turn"));
  adapter.ingest({ type: "turn-start", prompt: "stream output" });
  adapter.ingest({ type: "tool-call", id: "live-tool", name: "shell.exec", argsDisplay: "example streaming command" });
  adapter.ingest({ type: "tool-start", id: "live-tool" });
  return {
    item() {
      const item = transcriptItems(services.transcript.getState()).find((candidate) => candidate.kind === "tool");
      if (item?.kind !== "tool") throw new Error("Missing live tool fixture");
      return item;
    },
    output(chunk: string, replace = false) { adapter.ingest({ type: "tool-output", id: "live-tool", chunk, replace }); },
    finish(artifactPath?: string) { adapter.ingest({ type: "tool-result", id: "live-tool", ok: true, summary: "finished", artifactPath }); },
  };
}

export function liveJob(path: string) {
  let current = job({ stdoutArtifact: path, artifactPath: path });
  const listeners = new Set<JobManagerListener>();
  const port: JobsPort = {
    ...createJobsPort(() => [current], []),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const emit = (): void => { for (const listener of listeners) listener({ type: "job", jobId: current.id }); };
  return {
    port,
    emit,
    listeners: () => listeners.size,
    update(patch: Partial<BackgroundJob>) { current = { ...current, ...patch }; emit(); },
  };
}

export const numberedOutput = (count: number): string => Array.from({ length: count }, (_, index) => `stream line ${index + 1}`).join("\n");
