export function copyString(text: string): string {
  return Buffer.from(text, "utf16le").toString("utf16le");
}
