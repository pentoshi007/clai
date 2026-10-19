const values = new Set<string>();
let revision = 0;
let ordered: readonly string[] = [];

function addValue(value: string): boolean {
  if (!value) return false;
  const encoded = JSON.stringify(value).slice(1, -1);
  if (values.has(value) && values.has(encoded)) return false;
  values.add(value);
  values.add(encoded);
  return true;
}

function refresh(): void {
  ordered = [...values].sort((a, b) => b.length - a.length);
  revision += 1;
}

export function registerKnownSecret(value: string): void {
  if (addValue(value)) refresh();
}

export function registerSensitiveText(text: string): void {
  let changed = addValue(text);
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    changed = addValue(value) || changed;
    const field = value.match(/^(?:password|passwd|passphrase|secret|token|api[_ -]?key)\s*[:=]\s*(.+)$/i);
    if (field?.[1]) changed = addValue(field[1]) || changed;
  }
  if (changed) refresh();
}

export function redactKnownSecrets(text: string): string {
  let result = text;
  for (const secret of ordered) {
    if (result.includes(secret)) result = result.split(secret).join("[redacted]");
  }
  return result;
}

export function knownSecretsRevision(): number {
  return revision;
}

export function resetKnownSecrets(): void {
  values.clear();
  ordered = [];
  revision += 1;
}
