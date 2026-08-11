export async function readStdinText(
  input: NodeJS.ReadableStream & AsyncIterable<Buffer | string>,
): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of input) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  }
  return chunks.join("").trim();
}
