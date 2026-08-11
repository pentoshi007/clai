import fcntl
import os
import select
import struct
import subprocess
import sys
import termios


def main() -> int:
    command = sys.argv[2:] if sys.argv[1] == "--" else sys.argv[1:]
    if not command:
        sys.stderr.write("pty-driver: missing command\n")
        return 2
    master, slave = os.openpty()
    # 30 rows x 100 columns, matching the test dimensions.
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    # Sane cooked-mode settings: ISIG must be present or ^C never becomes
    # SIGINT (pty.openpty defaults are not guaranteed).
    attrs = termios.tcgetattr(slave)
    attrs[0] |= termios.BRKINT | termios.ICRNL | termios.IXON
    attrs[1] |= termios.OPOST | termios.ONLCR
    attrs[3] |= termios.ISIG | termios.ICANON | termios.ECHO | termios.IEXTEN
    attrs[6][termios.VMIN] = 1
    attrs[6][termios.VTIME] = 0
    termios.tcsetattr(slave, termios.TCSANOW, attrs)
    env = {**os.environ, "TERM": "xterm-256color"}
    def preexec() -> None:
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)

    child = subprocess.Popen(
        command,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        preexec_fn=preexec,
        close_fds=True,
        env=env,
    )
    os.close(slave)
    master_fd = master
    stdin_fd = sys.stdin.fileno()
    stdout = sys.stdout.buffer

    master_eof = False
    while not master_eof:
        if child.poll() is not None:
            try:
                data = os.read(master_fd, 65536)
                while data:
                    stdout.write(data)
                    stdout.flush()
                    data = os.read(master_fd, 65536)
            except OSError:
                pass
            break
        ready, _, _ = select.select([master_fd, stdin_fd], [], [], 0.25)
        for fd in ready:
            if fd == master_fd:
                try:
                    data = os.read(master_fd, 65536)
                except OSError:
                    data = b""
                if not data:
                    master_eof = True
                else:
                    stdout.write(data)
                    stdout.flush()
            else:
                try:
                    data = os.read(stdin_fd, 65536)
                except OSError:
                    data = b""
                if data:
                    os.write(master_fd, data)
    os.close(master_fd)
    return child.wait()


if __name__ == "__main__":
    sys.exit(main())
