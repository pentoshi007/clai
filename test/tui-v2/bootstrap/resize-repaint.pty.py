import errno
import fcntl
import json
import os
import pty
import runpy
import select
import struct
import subprocess
import termios
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
LABEL = b"PTY repaint continuity"
MOUSE = b"\x1b[<0;2;1M\x1b[<0;2;1m"
ALT_ON = b"\x1b[?1049h"
ALT_OFF = b"\x1b[?1049l"
ScreenProbe = runpy.run_path(str(ROOT / "scripts/pty-smoke.py"))["ScreenProbe"]


class ContinuityError(RuntimeError):
    pass


class PtyTimeout(RuntimeError):
    def __init__(self, messages, output):
        super().__init__(f"PTY timeout: status={messages!r}, output={output!r}")
        self.messages = messages
        self.output = output


def claim_terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


def run_case(suspend_control=False):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 8, 40, 0, 0))
    initial_modes = termios.tcgetattr(slave)
    command = ["bun", "run", str(ROOT / "test/tui-v2/bootstrap/resize-repaint.pty.ts")]
    if suspend_control:
        command.append("--suspend-control")
    status_fd, status_write = os.pipe()
    env = {
        **os.environ,
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "CLAI_REPAINT_TEST_STATUS_FD": str(status_write),
    }
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        env=env,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        pass_fds=(status_write,),
        preexec_fn=claim_terminal,
    )
    os.close(status_write)
    output = bytearray()
    messages = []
    pending_status = bytearray()
    probe = ScreenProbe(40, 8)
    check_raw = False
    samples = 0
    active_fds = {master, status_fd}

    def pump(timeout=0.002):
        nonlocal samples
        if check_raw:
            samples += 1
            modes = termios.tcgetattr(slave)
            if modes[3] & (termios.ECHO | termios.ICANON | termios.ISIG):
                raise ContinuityError("kernel raw mode dropped during repaint")
        readable, _, _ = select.select(list(active_fds), [], [], timeout)
        for fd in readable:
            try:
                data = os.read(fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                active_fds.discard(fd)
                continue
            if fd == master:
                output.extend(data)
                probe.feed(data)
            else:
                pending_status.extend(data)
                while b"\n" in pending_status:
                    line, _, rest = pending_status.partition(b"\n")
                    pending_status[:] = rest
                    message = json.loads(line)
                    if message.get("event") == "error":
                        raise RuntimeError(message["message"])
                    messages.append(message)

    def wait_for(predicate):
        deadline = time.monotonic() + 5
        while not predicate():
            if time.monotonic() >= deadline:
                raise PtyTimeout(list(messages), bytes(output[-500:]))
            if process.poll() is not None:
                raise RuntimeError(f"native renderer exited early: {process.returncode}")
            pump()

    def count_events(event):
        return sum(message.get("event") == event for message in messages)

    try:
        wait_for(lambda: count_events("ready") == 1 and LABEL in output)
        assert ALT_ON in output, "native renderer never entered the alternate screen"
        check_raw = True
        pump()
        baseline_screen = [list(row) for row in probe.screen]
        baseline_output = len(output)
        for attempt in range(12):
            previous_frames = output.count(LABEL)
            os.write(master, b"r")
            for _ in range(3):
                pump()
                os.write(master, MOUSE)
                pump()
            wait_for(lambda: (
                count_events("repainted") == attempt + 1
                and count_events("mouse") == (attempt + 1) * 3
                and output.count(LABEL) > previous_frames
            ))
            assert probe.screen == baseline_screen, "repaint changed the visible screen"
            repaint_output = output[baseline_output:]
            for forbidden in (
                ALT_ON, ALT_OFF, b"\x1b[?1047l", b"\x1b[?47l",
                b"\x1b[?1003l", b"\x1b[?1006l", b"\x1b[H\x1b[J",
                b"[<0;2;1", b"^[",
            ):
                if forbidden in repaint_output:
                    raise ContinuityError(f"terminal ownership changed or input echoed: {forbidden!r}")
        assert samples >= 72, f"insufficient kernel mode samples: {samples}"
        check_raw = False
        os.write(master, b"q")
        deadline = time.monotonic() + 5
        while process.poll() is None and time.monotonic() < deadline:
            pump()
        assert process.wait(timeout=1) == 0
        while master in active_fds and select.select([master], [], [], 0)[0]:
            pump(0)
        assert ALT_OFF in output[baseline_output:], "normal shutdown did not leave the alternate screen"
        restored_modes = termios.tcgetattr(slave)
        for flag in (termios.ECHO, termios.ICANON):
            assert restored_modes[3] & flag == initial_modes[3] & flag
        return samples
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        os.close(status_fd)
        os.close(master)
        os.close(slave)


try:
    run_case(suspend_control=True)
except ContinuityError:
    pass
except PtyTimeout as error:
    if error.output == b"" and any(m.get("event") == "ready" for m in error.messages):
        print("PTY native output unavailable in this environment; continuity test skipped")
        raise SystemExit(0)
    raise
else:
    raise AssertionError("PTY continuity detector did not reject native suspend/resume")

samples = run_case()
print(f"PTY repaint continuity passed: 12 repaints, 36 mouse reports, {samples} raw-mode samples")
