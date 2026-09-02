import type { CommandInvocation } from "../../../app/commands/command.js";
import { getSession, listSessionSummaries, purgeSession } from "../../../store/history.js";
import type { AppServices } from "../../bootstrap/composition-root.js";
import { applySessionResume, resumeNotices } from "../../bootstrap/session-resume.js";
import type { PickerOption } from "../../rendering/picker-filter.js";
import { relativeTime, shortCwd } from "../../rendering/text-format.js";
import { conversationItemCount } from "../../state/transcript-types.js";

export async function handleHistory(services: AppServices, invocation?: CommandInvocation): Promise<void> {
  const rawArgs = invocation?.args?.trim() ?? "";
  const { listLiveSessionRuntimes } = await import(
    "../../../session-runtime/discovery.js"
  );
  const runtimes = await listLiveSessionRuntimes().catch(() => []);
  const runtimeById = new Map(runtimes.map((runtime) => [runtime.sessionId, runtime]));
  if (rawArgs) {
    const [sub, ...rest] = rawArgs.split(/\s+/);
    const subLower = sub?.toLowerCase() ?? "";
    if (["delete", "remove", "rm", "del"].includes(subLower)) {
      const finalId = rest.join(" ").trim();
      if (!finalId) {
        services.session.notice("warn", "usage: /history delete <session-id>");
        return;
      }
      if (runtimeById.has(finalId)) {
        services.session.notice("warn", "detach or exit the live session before deleting it");
        return;
      }
      const result = await purgeSession(finalId);
      services.session.notice(
        result.deleted ? "info" : "warn",
        result.deleted ? `deleted ${finalId}` : result.detail,
      );
      return;
    }
  }

  const sessions = await listSessionSummaries(200, { recovery: "background" });
  const currentMessages = services.session.messages;
  const currentId = services.session.sessionId;
  const currentTitle = services.session.getState().title;
  if (
    sessions.length === 0 &&
    runtimes.filter((runtime) => runtime.sessionId !== currentId).length === 0 &&
    currentMessages.length === 0
  ) {
    services.session.notice(
      "info",
      "no session history yet — chat once and it will appear here with an AI title",
    );
    return;
  }

  const otherSessions = sessions.filter((session) => session.id !== currentId);
  const historyIds = new Set(sessions.map((session) => session.id));
  const runtimeOnly = runtimes.filter(
    (runtime) => runtime.sessionId !== currentId && !historyIds.has(runtime.sessionId),
  );
  const liveVisualCount = conversationItemCount(services.transcript.getState());
  const options: PickerOption[] = [
    {
      value: "__current__",
      label: currentTitle?.trim() || "Current session",
      description: currentMessages.length
        ? `id ${currentId}  ·  now  ·  ${liveVisualCount} items  ·  ${currentMessages.length} model msgs  ·  this window`
        : `id ${currentId}  ·  now  ·  empty session  ·  this window`,
      active: true,
    },
    ...runtimeOnly.map((runtime) => ({
      value: runtime.sessionId,
      label: runtime.title?.trim() || "Live session",
      description: [
        `id ${runtime.sessionId}`,
        runtime.busy ? "agent running" : "live",
        runtime.attached ? "attached elsewhere" : "detached",
        shortCwd(runtime.cwd) ? `in ${shortCwd(runtime.cwd)}` : "",
      ]
        .filter(Boolean)
        .join("  ·  "),
      active: false,
    })),
    ...otherSessions.map((session) => {
      const runtime = runtimeById.get(session.id);
      const count = session.itemCount;
      const date = session.updatedAt ?? session.createdAt;
      const title = (session.name && session.name.trim()) || "Untitled chat";
      const meta = [
        `id ${session.id}`,
        runtime
          ? runtime.busy
            ? "agent running"
            : runtime.attached
              ? "live · attached elsewhere"
              : "live · detached"
          : relativeTime(date) || "some time ago",
        date.slice(0, 16).replace("T", " "),
        `${count} item${count === 1 ? "" : "s"}`,
        shortCwd(session.cwd) ? `in ${shortCwd(session.cwd)}` : "",
      ]
        .filter(Boolean)
        .join("  ·  ");
      return {
        value: session.id,
        label: title,
        description: meta,
        active: false,
      };
    }),
  ];
  const liveOptions = [...options];
  const deleteRow = (value: string): void => {
    if (value === "__current__") {
      services.toast.warn("cannot delete the session you are in", {
        key: "history-delete",
      });
      return;
    }
    if (runtimeById.has(value)) {
      services.toast.warn("cannot delete a live session", {
        key: "history-delete",
      });
      return;
    }
    const index = liveOptions.findIndex((option) => option.value === value);
    if (index === -1) return;
    const option = liveOptions[index]!;
    const label = option.label;
    liveOptions.splice(index, 1);
    services.overlay.replacePickerOptions([...liveOptions]);
    services.toast.info(`deleting ${label}…`, { key: "history-delete" });
    void (async () => {
      const result = await purgeSession(value);
      if (result.deleted) {
        services.toast.success(`deleted ${label} · ${result.detail}`, {
          key: "history-delete",
        });
      } else {
        if (!liveOptions.some((candidate) => candidate.value === value)) {
          liveOptions.splice(Math.min(index, liveOptions.length), 0, option);
          services.overlay.replacePickerOptions([...liveOptions]);
        }
        services.toast.error(`could not delete ${label} · ${result.detail}`, {
          key: "history-delete",
        });
      }
    })();
  };

  services.overlay.openPicker(
    {
      title: "History",
      twoLine: true,
      historyStyle: true,
      searchDescription: true,
      rowAction: { chord: "ctrl+x", hint: "^x:delete" },
      options,
    },
    (value) => {
      void (async () => {
        if (value === "__current__") {
          services.session.notice("info", "showing current session");
          services.overlay.close();
          return;
        }
        const session = await getSession(value);
        const runtime = runtimeById.get(value);
        if (!session && !runtime) {
          services.session.notice("warn", "session not found");
          services.overlay.close();
          return;
        }
        if (value === currentId) {
          services.session.notice("info", "already on this session");
          services.overlay.close();
          return;
        }
        if (currentMessages.length > 0) {
          await services.session.persistNow().catch(() => undefined);
        }
        const state = services.session.getState();
        const busy =
          state.running ||
          state.compacting ||
          state.queued.length > 0 ||
          state.responder.running > 0 ||
          state.responder.ready > 0 ||
          state.responder.delivered > 0;
        if (services.requestSessionSwitch(value, !busy)) {
          services.overlay.close();
          return;
        }
        if (!session) {
          services.session.notice(
            "warn",
            `session is live in another runtime · use clai --resume ${value}`,
          );
          services.overlay.close();
          return;
        }
        const outcome = await applySessionResume(services, session);
        for (const entry of resumeNotices(outcome)) {
          services.session.notice(entry.level, entry.text);
        }
        services.overlay.close();
      })();
    },
    deleteRow,
  );
}
