import { existsSync } from "node:fs";
import { join } from "node:path";
import { stageWindowsUpdate } from "../../src/commands/update/windows-stage.js";

const [root, node, version] = process.argv.slice(2);
if (!root || !node || !version) throw new Error("missing worker integration fixture arguments");
const marker = join(root, "applied.txt");
const status = await stageWindowsUpdate({
  kind: "commands",
  commands: [{ file: node, args: ["-e", `let alive = false; try { process.kill(${process.pid}, 0); alive = true; } catch {} require('fs').writeFileSync(${JSON.stringify(marker)}, alive ? 'owner still alive' : 'applied after owner exit')`] }],
  verification: { file: node, args: ["--version"] },
  version,
  allowNewer: false,
});
if (existsSync(marker)) throw new Error("worker applied before its owner exited");
console.log(JSON.stringify({ status }));
