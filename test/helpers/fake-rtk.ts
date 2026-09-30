import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export interface FakeRtk {
  readonly dir: string;
  readonly path: string;
  readonly invocations: () => Promise<string[]>;
  readonly dispose: () => Promise<void>;
}

export const FAKE_RTK_MARKER = "[fake-rtk]";

const script = (log: string): string => `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  --version)
    echo "rtk 0.50.0"
    exit 0
    ;;
  rewrite)
    shift
    command="$*"
    case "$command" in
      "git status"|"git diff"|"grep "*|"diff "*)
        echo "rtk $command"
        exit 3
        ;;
      "fake-allow")
        echo "rtk fake-allow"
        exit 0
        ;;
      "fake-deny")
        echo "rtk fake-deny"
        exit 2
        ;;
      "fake-same")
        echo "fake-same"
        exit 3
        ;;
      "fake-multiline")
        printf 'rtk one\\nrtk two\\n'
        exit 3
        ;;
      "fake-silent")
        exit 3
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  git)
    shift
    echo "${FAKE_RTK_MARKER} git $*"
    echo "hook-warning=$RTK_SUPPRESS_HOOK_WARNING"
    exit 0
    ;;
  grep|diff)
    tool="$1"
    shift
    echo "${FAKE_RTK_MARKER} $tool"
    exec "$tool" "$@"
    ;;
  *)
    echo "rtk: unknown command $1" >&2
    exit 2
    ;;
esac
`;

export const installFakeRtk = async (options: { onPath?: boolean } = {}): Promise<FakeRtk> => {
  const dir = await mkdtemp(join(tmpdir(), "clai-fake-rtk-"));
  const bin = join(dir, "bin");
  const log = join(dir, "invocations.log");
  const path = join(bin, "rtk");
  await mkdir(bin, { recursive: true });
  await writeFile(log, "");
  await writeFile(path, script(log));
  await chmod(path, 0o755);
  const previousPath = process.env.PATH;
  if (options.onPath !== false) {
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  }
  return {
    dir: bin,
    path,
    invocations: async () => (await readFile(log, "utf8")).split("\n").filter(Boolean),
    dispose: async () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(dir, { recursive: true, force: true });
    },
  };
};
