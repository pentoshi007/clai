/** @jsxImportSource @opentui/react */

import { useMemo, useRef, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { useTerminalDimensionsContext } from "../../hooks/terminal-dimensions.js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import type { PromptActionsRequest } from "../../../ui-core/controllers/overlay-controller.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { chordFromKeyEvent } from "../../input/chord-from-opentui-key.js";
import { preparePromptPreview } from "../../../ui-core/rendering/prompt-preview.js";

const HIDDEN_SCROLLBARS = {
  visible: false,
  showArrows: false,
} as const;

export function PromptActionsModal(props: {
  services: AppServices;
  theme: Theme;
  request: PromptActionsRequest;
}): ReactNode {
  const { services, theme, request } = props;
  const { width: termWidth, height: termHeight } = useTerminalDimensionsContext();
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  const cardWidth = Math.min(72, Math.max(36, Math.floor(termWidth * 0.55)));
  const bodyCols = Math.max(16, cardWidth - 8);
  const bodyMaxLines = Math.max(6, Math.min(16, Math.floor(termHeight * 0.4)));
  const bodyHeight = bodyMaxLines + 2;

  const preview = useMemo(
    () => preparePromptPreview(request.prompt, bodyCols, bodyMaxLines),
    [request.prompt, bodyCols, bodyMaxLines],
  );

  const copy = (): void => {
    services.overlay.close();
    void services.ports.clipboard.writeText(request.prompt);
  };
  const resend = (): void => {
    services.overlay.close();
    request.onResend();
  };
  const close = (): void => {
    services.overlay.close();
  };
  const openFull = (): void => {
    services.overlay.close();
    services.overlay.openPager(
      "Prompt",
      request.prompt,
      undefined,
      undefined,
      "plain",
    );
  };

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    const chord = chordFromKeyEvent(key);
    if (chord === "c") copy();
    else if (chord === "r" || chord === "enter") resend();
    else if (chord === "p" || chord === "o") openFull();
    else if (chord === "escape") close();
    else if (chord === "up" || chord === "k") {
      scrollRef.current?.scrollBy(-1);
    } else if (chord === "down" || chord === "j") {
      scrollRef.current?.scrollBy(1);
    } else return;
    key.preventDefault();
  });

  const meta =
    preview.truncated || preview.totalLines > preview.lines.length
      ? `showing ${preview.lines.length}/${preview.totalLines} lines · p:full`
      : preview.totalLines > 1
        ? `${preview.totalLines} lines`
        : "";

  return (
    <box
      border
      borderStyle="rounded"
      title=" Prompt "
      titleAlignment="center"
      style={{
        flexDirection: "column",
        width: cardWidth,
        maxHeight: Math.max(12, Math.floor(termHeight * 0.75)),
        borderColor: theme.userBorder,
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 1,
        paddingBottom: 1,
        flexShrink: 0,
      }}
    >
      <box style={{ flexDirection: "row", marginBottom: 1, width: "100%" }}>
        <text content=" YOU " style={{ fg: theme.white, bg: theme.prompt }} />
        <text
          content="  actions for this message"
          style={{ fg: theme.muted }}
        />
      </box>

      {}
      <box
        border
        borderStyle="rounded"
        style={{
          flexDirection: "column",
          width: "100%",
          height: bodyHeight,
          maxHeight: bodyHeight,
          borderColor: theme.chipIndigo,
          backgroundColor: theme.background,
          paddingLeft: 1,
          paddingRight: 1,
          marginBottom: 1,
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        <scrollbox
          ref={scrollRef}
          scrollY
          scrollX={false}
          stickyScroll={false}
          scrollbarOptions={HIDDEN_SCROLLBARS}
          verticalScrollbarOptions={HIDDEN_SCROLLBARS}
          horizontalScrollbarOptions={HIDDEN_SCROLLBARS}
          style={{
            flexGrow: 1,
            width: "100%",
            height: Math.max(1, bodyMaxLines),
          }}
        >
          {preview.lines.map((line, i) => (
            <text
              key={i}
              content={line.length > 0 ? line : " "}
              selectable
              wrapMode="none"
              style={{
                fg: theme.foreground,
                height: 1,
                width: bodyCols,
              }}
            />
          ))}
        </scrollbox>
      </box>

      {meta ? (
        <text
          content={meta}
          style={{ fg: theme.muted, height: 1, marginBottom: 0 }}
        />
      ) : null}

      <box
        style={{
          flexDirection: "row",
          justifyContent: "flex-start",
          width: "100%",
          flexShrink: 0,
        }}
      >
        <text
          content=" c:copy "
          style={{ fg: theme.white, bg: theme.chipTeal }}
          onMouseDown={copy}
        />
        <text content="  " />
        <text
          content=" r:resend "
          style={{ fg: theme.white, bg: theme.mode }}
          onMouseDown={resend}
        />
        <text content="  " />
        <text
          content=" p:full "
          style={{ fg: theme.white, bg: theme.chip }}
          onMouseDown={openFull}
        />
        <text content="  " />
        <text
          content=" esc:close "
          style={{ fg: theme.white, bg: theme.chipIndigo }}
          onMouseDown={close}
        />
      </box>
    </box>
  );
}
