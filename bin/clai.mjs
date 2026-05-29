#!/usr/bin/env node
// Guard against a deleted / inaccessible working directory BEFORE importing
// anything from dist. If clai was launched (or elevated via `sudo`) from a
// folder that no longer exists, process.cwd() throws ENOENT (uv_cwd) and the
// whole CLI used to crash at module-load. Relocate to a directory that
// definitely exists so startup — and every later spawn — works.
try {
  process.cwd();
} catch {
  const candidates = [
    process.env.HOME,
    process.env.USERPROFILE,
    process.env.TMPDIR,
    "/tmp",
    "/",
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      process.chdir(dir);
      break;
    } catch {
      // try the next candidate
    }
  }
}

await import('../dist/index.js');
