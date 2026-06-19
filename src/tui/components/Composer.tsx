import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { getSlashCommandSuggestions, type SlashCommand } from "../../repl.js";

export interface ComposerProps {
  busy: boolean;
  disabled: boolean;
  onSubmit: (text: string) => void;
}

const MAX_SUGGESTIONS = 6;

export function Composer({ busy, disabled, onSubmit }: ComposerProps) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(0);
  const history = useRef<string[]>([]);
  const historyIdx = useRef<number>(-1);

  const suggestions: SlashCommand[] = value.startsWith("/")
    ? getSlashCommandSuggestions(value).slice(0, MAX_SUGGESTIONS)
    : [];
  const menuOpen = suggestions.length > 0;

  const setText = (next: string, nextCursor?: number): void => {
    setValue(next);
    setCursor(nextCursor ?? next.length);
    setSelected(0);
  };

  const submit = (): void => {
    const text = value.trim();
    if (!text) return;
    history.current.push(value);
    historyIdx.current = -1;
    setValue("");
    setCursor(0);
    setSelected(0);
    onSubmit(text);
  };

  useInput(
    (input, key) => {
      if (disabled) return;

      // Slash menu navigation
      if (menuOpen && (key.upArrow || key.downArrow)) {
        setSelected((s) => {
          const n = suggestions.length;
          return key.upArrow ? (s - 1 + n) % n : (s + 1) % n;
        });
        return;
      }
      if (menuOpen && key.tab) {
        const cmd = suggestions[selected]!.command + " ";
        setText(cmd);
        return;
      }

      if (key.return) {
        if (menuOpen) {
          // Run the highlighted command directly. Commands that need args are
          // reached by typing a space first (which closes the menu).
          const cmd = suggestions[selected]!.command;
          history.current.push(cmd);
          historyIdx.current = -1;
          setValue("");
          setCursor(0);
          setSelected(0);
          onSubmit(cmd);
          return;
        }
        submit();
        return;
      }

      // History (only when menu closed)
      if (!menuOpen && key.upArrow) {
        if (history.current.length === 0) return;
        const idx =
          historyIdx.current < 0
            ? history.current.length - 1
            : Math.max(0, historyIdx.current - 1);
        historyIdx.current = idx;
        setText(history.current[idx] ?? "");
        return;
      }
      if (!menuOpen && key.downArrow) {
        if (historyIdx.current < 0) return;
        const idx = historyIdx.current + 1;
        if (idx >= history.current.length) {
          historyIdx.current = -1;
          setText("");
          return;
        }
        historyIdx.current = idx;
        setText(history.current[idx] ?? "");
        return;
      }

      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(value.length, c + 1));
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        const next = value.slice(0, cursor - 1) + value.slice(cursor);
        setValue(next);
        setCursor(cursor - 1);
        setSelected(0);
        return;
      }
      if (key.ctrl || key.meta) return; // handled at app level (abort/quit/toggle)
      if (input) {
        const next = value.slice(0, cursor) + input + value.slice(cursor);
        setValue(next);
        setCursor(cursor + input.length);
        setSelected(0);
      }
    },
    { isActive: !disabled },
  );

  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1) || " ";
  const after = value.slice(cursor + 1);
  const placeholder = busy
    ? "type to queue a message while clai works…"
    : "ask anything · / for commands · esc to cancel · ctrl+c to exit";

  return (
    <Box flexDirection="column">
      {menuOpen ? (
        <Box flexDirection="column" marginBottom={1} paddingX={1}>
          {suggestions.map((cmd, i) => (
            <Text key={cmd.command} {...(i === selected ? { color: "magenta" as const } : {})}>
              <Text color={i === selected ? "magenta" : "cyan"}>
                {cmd.command}
              </Text>
              {cmd.usage ? <Text dimColor> {cmd.usage}</Text> : null}
              <Text dimColor>{"  —  "}{cmd.description}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
      <Box
        borderStyle="round"
        borderColor={busy ? "yellow" : "magenta"}
        paddingX={1}
      >
        <Text color={busy ? "yellow" : "magenta"}>{"❯ "}</Text>
        {value.length === 0 ? (
          <Text dimColor>{placeholder}</Text>
        ) : (
          <Text>
            {before}
            <Text inverse>{at}</Text>
            {after}
          </Text>
        )}
      </Box>
    </Box>
  );
}
