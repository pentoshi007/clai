import os, pty, time, select, struct, fcntl, termios, re, subprocess

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

env = dict(os.environ, TERM="xterm-256color")
p = subprocess.Popen(
    ["node", "bin/clai.mjs", "--tui", "--no-history"],
    stdin=slave, stdout=slave, stderr=slave,
    start_new_session=True, env=env,
)
os.close(slave)

buf = []
def drain(t):
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.1)
        if r:
            try:
                d = os.read(master, 65536)
            except OSError:
                return
            if d:
                buf.append(d.decode("utf-8", "replace"))

drain(1.2)
steps = [
    ("/help", 0.3), ("\r", 0.5),
    ("\x0f", 0.5),          # Ctrl+O (no tool output -> nothing)
    ("/jobs", 0.3), ("\r", 0.5),  # opens jobs panel
    ("q", 0.4),             # close panel
    ("hello", 0.3),         # type some text
]
for keys, wait in steps:
    os.write(master, keys.encode())
    drain(wait)
os.write(master, b"\x03\x03")
drain(0.5)
try:
    p.terminate()
except Exception:
    pass

out = "".join(buf)
c = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", out)
c = re.sub(r"\x1b[>=]", "", c).replace("\x1b(B", "")
with open("/tmp/clai_pty.txt", "w") as f:
    f.write(c[-2600:])
