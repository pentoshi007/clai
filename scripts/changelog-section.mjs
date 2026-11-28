#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_HEADING = /^## v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/;

export function changelogSection(markdown, version) {
  const wanted = version.replace(/^v/, "");
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => VERSION_HEADING.exec(line)?.[1] === wanted);
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const body = lines.slice(start + 1, end === -1 ? lines.length : end).join("\n").trim();
  return body === "" ? null : body;
}

function main() {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: changelog-section.mjs <version>");
    process.exit(2);
  }
  const section = changelogSection(readFileSync(resolve("CHANGELOG.md"), "utf8"), version);
  if (section === null) {
    console.error(`No CHANGELOG.md section for ${version}`);
    process.exit(1);
  }
  process.stdout.write(`${section}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
