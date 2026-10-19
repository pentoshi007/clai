import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement, useEffect, useSyncExternalStore } from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { asToolCallId } from "../../../src/app/events/app-event.js";
import { useFeed, type FeedSnapshot } from "../../../src/classic/app/use-feed.js";
import { TranscriptResources } from "../../../src/classic/feed/transcript-resources.js";
import { EMPTY_TRANSCRIPT_STATE, transcriptItems, type ToolItem } from "../../../src/ui-core/state/transcript-types.js";
import { scriptedTurn } from "../feed/fixture.js";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness | undefined;
let ui: ReturnType<typeof render> | undefined;
let directory: string | undefined;
let latest: FeedSnapshot | undefined;

afterEach(async () => {
  ui?.unmount();
  ui?.cleanup();
  harness?.dispose();
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
  harness = undefined;
  ui = undefined;
  latest = undefined;
  directory = undefined;
});

function Probe() {
  const snapshot = useSyncExternalStore(harness!.wiring.subscribe, harness!.wiring.getSnapshot);
  const feed = useFeed({
    services: harness!.services,
    state: snapshot.transcript,
    columns: 80,
    liveBudgetRows: 10,
    now: snapshot.feedNow,
    generation: snapshot.feedGeneration,
    liveOffset: snapshot.liveOffset,
    navigationVersion: snapshot.feedNavigationVersion,
    intro: undefined,
  });
  latest = feed;
  useEffect(() => harness!.wiring.observeFeed(feed), [feed]);
  return createElement(Text, {}, feed.window.rows.map((row) => row.line).join("\n"));
}

it("keeps the paused item and row when offscreen artifact resources are released", async () => {
  directory = await mkdtemp(join(tmpdir(), "clai-resource-viewport-"));
  const path = join(directory, "output.txt");
  const output = Array.from({ length: 200 }, (_, index) => `complete line ${index}`).join("\n");
  await writeFile(path, output);
  const original = transcriptItems(scriptedTurn().state).find((item): item is ToolItem => item.kind === "tool" && item.name === "shell.exec")!;
  const tools = Array.from({ length: 4 }, (_, index) => ({
    ...original,
    id: `t${index}`,
    toolCallId: asToolCallId(`c${index}`),
    artifactPath: path,
    outputBytes: output.length,
  }));
  harness = createHarness({ columns: 80 });
  harness.services.transcript.hydrate({
    ...EMPTY_TRANSCRIPT_STATE,
    expandOutputGlobal: true,
    order: tools.map((item) => item.id),
    byId: new Map(tools.map((item) => [item.id, item])),
  });
  harness.services.transcript.setOutputGlobal(true);
  for (const item of tools) harness.services.session.spool.replace(item.toolCallId, "resident tail");
  const prepare = TranscriptResources.prototype.prepare;
  let automatic = false;
  vi.spyOn(TranscriptResources.prototype, "prepare").mockImplementation(function (this: TranscriptResources, state, visibleIds) {
    return automatic ? prepare.call(this, state, visibleIds) : Promise.resolve();
  });
  ui = render(createElement(Probe));
  await vi.waitFor(() => expect(latest).toBeDefined());
  const resources = latest!.context.spool;
  if (!(resources instanceof TranscriptResources)) throw new Error("expected transcript resources");
  await prepare.call(resources, harness.services.transcript.getState(), [tools[0]!.id, tools[1]!.id]);
  await vi.waitFor(() => expect(harness!.wiring.maxLiveOffset).toBe(latest!.window.maxOffset));
  harness.wiring.scrollFeed(215);
  await vi.waitFor(() => expect(latest!.window.offset).toBe(215));
  expect(latest!.window.totalRows).toBeGreaterThan(400);
  const anchor = latest!.window.rows[0]!.key;
  expect(latest!.window.firstItemId).toBe("t0");
  expect(latest!.window.rows[0]!.lineIndex).toBeGreaterThan(100);
  const before = latest!.window.totalRows;
  automatic = true;
  await prepare.call(resources, harness.services.transcript.getState(), latest!.window.visibleItemIds);
  await vi.waitFor(() => {
    expect(latest!.window.totalRows).toBeLessThan(before);
    expect(latest!.window.rows[0]!.key).toBe(anchor);
    expect(harness!.wiring.liveOffsetValue).toBe(latest!.window.offset);
  });
  expect(resources.tail(tools[0]!.toolCallId)).toBe(output);
  expect(resources.tail(tools[1]!.toolCallId)).toBe("resident tail");
  for (let index = 0; index < 8; index += 1) {
    await resources.prepare(harness.services.transcript.getState(), latest!.window.visibleItemIds);
    expect(latest!.window.rows[0]!.key).toBe(anchor);
  }
  harness.wiring.scrollFeed(-Number.MAX_SAFE_INTEGER);
  await vi.waitFor(() => {
    expect(latest!.window.offset).toBe(0);
    expect(latest!.window.lastItemId).toBe("t3");
    expect(resources.tail(tools[3]!.toolCallId)).toBe(output);
  });
  harness.wiring.scrollFeed(Number.MAX_SAFE_INTEGER);
  await vi.waitFor(() => {
    expect(latest!.window.firstItemId).toBe("t0");
    expect(latest!.window.rows[0]!.lineIndex).toBe(0);
    expect(resources.tail(tools[0]!.toolCallId)).toBe(output);
  });
  expect(resources.tail(tools[3]!.toolCallId)).toBe("resident tail");
  expect(harness.services.transcript.getState().order).toEqual(tools.map((item) => item.id));
});
