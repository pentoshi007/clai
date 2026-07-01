import { render } from "ink";
import { createElement } from "react";
import { EventEmitter } from "node:events";
import { App } from "../dist/tui/App.js";

let last = "";
const stdout = new EventEmitter();
stdout.columns = Number(process.env.SMOKE_COLS || 100);
stdout.rows = Number(process.env.SMOKE_ROWS || 30);
stdout.write = (s) => { last = s; return true; };

const stdin = new EventEmitter();
stdin.isTTY = true;
stdin.setRawMode = () => {};
stdin.setEncoding = () => {};
stdin.resume = () => {};
stdin.pause = () => {};
stdin.ref = () => {};
stdin.unref = () => {};
stdin.read = () => null;

const app = render(
  createElement(App, {
    version: "test",
    initialMode: "agent",
    provider: "groq",
    initialModel: "demo-model",
  }),
  { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
);

import { writeFileSync } from "node:fs";
setTimeout(() => {
  app.unmount();
  const clean = last.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  writeFileSync("/tmp/clai_frame.txt", clean);
  process.exit(0);
}, 500);
