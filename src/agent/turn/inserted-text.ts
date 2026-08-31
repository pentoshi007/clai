export const insertedText = (value: string, prefix: string): string =>
  value.startsWith(prefix) ? value.slice(prefix.length) : value;
