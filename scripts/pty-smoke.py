#!/usr/bin/env python3
"""Assertion-based POSIX smoke test for the classic Ink frontend.

The default scenario deliberately uses provider-independent UI actions so it is
safe to run in CI and on a developer machine without API credentials:
launch, render the help pager, close it, type a draft, resize, and exit with
Ctrl+C twice. Provider-backed turn/abort coverage remains a separate manual or
host-specific gate; this script never claims that a model or tool ran.
"""

from __future__ import annotations

import argparse
import codecs
import fcntl
import os
import pty
import re
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BRACKETED_PASTE_OFF = b"\x1b[?2004l"
CURSOR_SHOW = b"\x1b[?25h"
ALT_SCREEN_ON = b"\x1b[?1049h"
ALT_SCREEN_OFF = b"\x1b[?1049l"
CLEAR_SCREEN_ONLY = b"\x1b[2J"
CURSOR_HOME = b"\x1b[H"

CSI_RE = re.compile(rb"\x1b\[([0-9;?<>]*)([ -/]*)([@-~])")


def set_window_size(fd: int, columns: int, rows: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


def cell_width(char: str) -> int:
    if unicodedata.combining(char):
        return 0
    if unicodedata.east_asian_width(char) in {"W", "F"}:
        return 2
    return 1


class ScreenProbe:
    """Small ANSI screen model used only to validate final row width.

    It handles the cursor/erase sequences emitted by the classic renderer. Unknown
    CSI/OSC sequences are ignored rather than interpreted as text, which prevents
    control bytes from hiding a width violation.
    """

    def __init__(self, columns: int, rows: int) -> None:
        self.columns = columns
        self.rows = rows
        self.cursor_row = 0
        self.cursor_column = 0
        self.screen: list[list[str]] = [[] for _ in range(rows)]
        self._pending = b""

    def resize(self, columns: int, rows: int) -> None:
        self.columns = columns
        self.rows = rows
        self.cursor_row = min(self.cursor_row, rows - 1)
        self.cursor_column = min(self.cursor_column, columns)
        self.screen = [row[:columns] for row in self.screen[:rows]]
        self.screen.extend([[] for _ in range(rows - len(self.screen))])

    def feed(self, data: bytes) -> None:
        data = self._pending + data
        self._pending = b""
        index = 0
        while index < len(data):
            if data[index] != 0x1B:
                value = data[index]
                if value < 0x80:
                    self._write_byte(value)
                    index += 1
                    continue
                width = 1
                if value & 0xE0 == 0xC0:
                    width = 2
                elif value & 0xF0 == 0xE0:
                    width = 3
                elif value & 0xF8 == 0xF0:
                    width = 4
                if index + width > len(data):
                    self._pending = data[index:]
                    break
                try:
                    char = data[index : index + width].decode("utf-8")
                except UnicodeDecodeError:
                    self._write_byte(value)
                    index += 1
                else:
                    self._write_char(char)
                    index += width
                continue
            if index + 1 >= len(data):
                self._pending = data[index:]
                break
            if data[index + 1] == ord("["):
                match = CSI_RE.match(data, index)
                if match is None:
                    self._pending = data[index:]
                    break
                self._apply_csi(match.group(1), match.group(3))
                index = match.end()
                continue
            if data[index + 1] == ord("]"):
                end = data.find(b"\x07", index + 2)
                st = data.find(b"\x1b\\", index + 2)
                candidates = [value for value in (end, st) if value >= 0]
                if not candidates:
                    self._pending = data[index:]
                    break
                stop = min(candidates)
                self._pending = b"" if data[stop] == 0x07 else b""
                index = stop + (1 if data[stop] == 0x07 else 2)
                continue
            # Charset selection and other two-byte ESC sequences do not draw.
            index += 2

    def _write_byte(self, value: int) -> None:
        if value in (0x00, 0x07, 0x08, 0x0B, 0x0C):
            if value == 0x08:
                self.cursor_column = max(0, self.cursor_column - 1)
            return
        if value == 0x0D:
            self.cursor_column = 0
            return
        if value == 0x0A:
            self.cursor_row = min(self.rows - 1, self.cursor_row + 1)
            return
        if value == 0x09:
            self.cursor_column = min(self.columns, ((self.cursor_column // 8) + 1) * 8)
            return
        if value < 0x20 or value == 0x7F:
            return
        self._write_char(chr(value))

    def _write_char(self, char: str) -> None:
        width = cell_width(char)
        if width == 0:
            return
        if self.cursor_column >= self.columns:
            self.cursor_row = min(self.rows - 1, self.cursor_row + 1)
            self.cursor_column = 0
        row = self.screen[self.cursor_row]
        while len(row) < self.cursor_column:
            row.append(" ")
        if self.cursor_column < self.columns:
            if len(row) == self.cursor_column:
                row.append(char)
            else:
                row[self.cursor_column] = char
        self.cursor_column += width

    def _apply_csi(self, params: bytes, final: bytes) -> None:
        text = params.decode("ascii", "ignore")
        private = text.startswith("?")
        if private:
            text = text[1:]
        values = [int(value) if value else 1 for value in text.split(";") if value or ";" in text]
        value = values[0] if values else 1
        char = final.decode("ascii", "ignore")
        if char in {"m", "q", "h", "l", "p", "c"}:
            return
        if char in {"H", "f"}:
            self.cursor_row = max(0, min(self.rows - 1, (values[0] if values else 1) - 1))
            self.cursor_column = max(0, min(self.columns, (values[1] if len(values) > 1 else 1) - 1))
        elif char == "G":
            self.cursor_column = max(0, min(self.columns, value - 1))
        elif char == "A":
            self.cursor_row = max(0, self.cursor_row - value)
        elif char == "B":
            self.cursor_row = min(self.rows - 1, self.cursor_row + value)
        elif char == "C":
            self.cursor_column = min(self.columns, self.cursor_column + value)
        elif char == "D":
            self.cursor_column = max(0, self.cursor_column - value)
        elif char == "J":
            self.screen = [[] for _ in range(self.rows)]
        elif char == "K":
            self.screen[self.cursor_row] = self.screen[self.cursor_row][: self.cursor_column]

    def max_visible_row_width(self) -> int:
        return max(
            (sum(cell_width(char) for char in row) for row in self.screen),
            default=0,
        )

    def nonempty_rows(self) -> list[str]:
        return ["".join(row).rstrip() for row in self.screen if "".join(row).rstrip()]


def drain(master: int, output: bytearray, probe: ScreenProbe, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], min(0.05, max(0.0, deadline - time.monotonic())))
        if not ready:
            continue
        try:
            data = os.read(master, 65536)
        except OSError:
            return
        if not data:
            return
        output.extend(data)
        probe.feed(data)


def visible_text(data: bytes) -> str:
    text = data.decode("utf-8", "replace")
    text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)
    text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"\x1b[@-_]", "", text)
    return text.replace("\r", "")


def wait_for(
    process: subprocess.Popen[bytes],
    master: int,
    output: bytearray,
    probe: ScreenProbe,
    predicate,
    timeout: float,
    label: str,
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate(bytes(output)):
            return
        if process.poll() is not None:
            drain(master, output, probe, 0.1)
            break
        drain(master, output, probe, 0.05)
    if predicate(bytes(output)):
        return
    sample = visible_text(bytes(output))[-1200:]
    raise RuntimeError(f"timed out waiting for {label}; output tail:\n{sample}")


def send(master: int, data: bytes) -> None:
    os.write(master, data)


def run(timeout: float) -> int:
    if not (ROOT / "bin" / "clai.mjs").exists():
        raise RuntimeError("bin/clai.mjs is missing")
    if not (ROOT / "dist" / "index.js").exists():
        raise RuntimeError("dist/index.js is missing; run npm run build first")

    output = bytearray()
    probe = ScreenProbe(100, 30)
    master, slave = pty.openpty()
    set_window_size(master, 100, 30)
    set_window_size(slave, 100, 30)
    initial_termios = termios.tcgetattr(slave)

    with tempfile.TemporaryDirectory(prefix="clai-pty-") as sandbox:
        data_dir = Path(sandbox) / "data"
        config_dir = Path(sandbox) / "config"
        data_dir.mkdir()
        config_dir.mkdir()
        env = {k: v for k, v in os.environ.items() if k not in ("CI", "GITHUB_ACTIONS")}
        env.update(
            {
                "TERM": "xterm-256color",
                "COLORTERM": "truecolor",
                "CLAI_CONFIG_DIR": str(config_dir),
                "CLAI_DATA_DIR": str(data_dir),
                "CLAI_HISTORY_DIR": str(data_dir / "history"),
                "CLAI_DISABLE_KEYCHAIN": "1",
                "CLAI_NO_UPDATE_CHECK": "1",
                "CLAI_OFFLINE": "1",
                "CLAI_CLASSIC_MOUSE": "0",
            }
        )

        def preexec() -> None:
            os.setsid()
            try:
                fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            except OSError:
                pass

        process = subprocess.Popen(
            ["node", "bin/clai.mjs", "--classic", "--no-history"],
            cwd=ROOT,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=False,
            preexec_fn=preexec,
            close_fds=True,
            env=env,
        )

        try:
            wait_for(
                process,
                master,
                output,
                probe,
                lambda data: b"Ask anything" in data,
                timeout,
                "classic composer",
            )
            send(master, b"/help")
            drain(master, output, probe, 0.2)
            send(master, b"\r")
            drain(master, output, probe, 0.15)
            send(master, b"\r")
            wait_for(process, master, output, probe, lambda data: b"Commands" in data, timeout, "help pager")
            send(master, b"q")
            wait_for(
                process,
                master,
                output,
                probe,
                lambda data: b"Ask anything" in data,
                timeout,
                "composer after pager",
            )
            send(master, b"resize smoke")
            wait_for(process, master, output, probe, lambda data: b"resize smoke" in data, timeout, "draft echo")
            set_window_size(master, 60, 20)
            set_window_size(slave, 60, 20)
            probe.resize(60, 20)
            drain(master, output, probe, 0.6)
            send(master, b"\x03")
            drain(master, output, probe, 0.1)
            send(master, b"\x03")
            deadline = time.monotonic() + 3.0
            while process.poll() is None and time.monotonic() < deadline:
                drain(master, output, probe, 0.05)
            if process.poll() is None:
                raise RuntimeError("classic frontend did not exit after Ctrl+C twice")
            drain(master, output, probe, 0.2)
            return_code = process.wait(timeout=1)
        finally:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, 15)
                except OSError:
                    try:
                        process.terminate()
                    except OSError:
                        pass
                try:
                    process.kill()
                except OSError:
                    pass
                process.wait()
            try:
                final_termios = termios.tcgetattr(slave)
            except termios.error:
                final_termios = initial_termios
            os.close(master)
            os.close(slave)

    if return_code != 0:
        raise RuntimeError(f"classic frontend exited with {return_code}, expected 0")
    startup = output.find(ALT_SCREEN_ON)
    if startup < 0:
        raise RuntimeError("startup did not emit alternate-screen-on")
    clear = output.find(CLEAR_SCREEN_ONLY, startup)
    home = output.find(CURSOR_HOME, clear + len(CLEAR_SCREEN_ONLY)) if clear >= 0 else -1
    if clear < 0 or home < 0:
        raise RuntimeError("startup did not emit clear-screen and cursor-home")
    teardown = output.find(ALT_SCREEN_OFF, home + len(CURSOR_HOME))
    if teardown < 0:
        raise RuntimeError("teardown did not emit alternate-screen-off")
    cursor_show = output.find(CURSOR_SHOW, home)
    paste_off = output.find(BRACKETED_PASTE_OFF, home)
    if cursor_show < 0 or cursor_show > teardown:
        raise RuntimeError("teardown did not emit cursor-show before alternate-screen-off")
    if paste_off < 0 or paste_off > teardown:
        raise RuntimeError("teardown did not emit bracketed-paste-off before alternate-screen-off")
    if not (final_termios[3] & termios.ECHO):
        raise RuntimeError("PTY echo was not restored")
    if not (final_termios[3] & termios.ICANON):
        raise RuntimeError("PTY canonical input mode was not restored")
    if probe.max_visible_row_width() > 60:
        raise RuntimeError(
            f"post-resize screen row exceeded 60 columns ({probe.max_visible_row_width()})"
        )

    print(
        "PTY smoke passed: "
        f"exit={return_code}, bytes={len(output)}, "
        f"max_visible_row={probe.max_visible_row_width()}, "
        f"echo={'on' if final_termios[3] & termios.ECHO else 'off'}, "
        f"initial_echo={'on' if initial_termios[3] & termios.ECHO else 'off'}"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=5.0, help="seconds per UI readiness assertion")
    args = parser.parse_args()
    try:
        return run(args.timeout)
    except KeyboardInterrupt:
        return 130
    except Exception as error:  # noqa: BLE001 - CLI smoke diagnostics must be visible
        print(f"PTY smoke failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
