import type { DownloadProgress } from "./installers.js";
import { throwIfCancelled } from "./process.js";

export const MAX_BINARY_BYTES = 256 * 1024 * 1024;

export async function downloadBinary(
  url: string,
  timeoutMs = 120_000,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
  maxBytes = MAX_BINARY_BYTES,
): Promise<Buffer> {
  throwIfCancelled(signal);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal, headers: { "User-Agent": "clai-updater" } });
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status}) for ${url}`);
    const length = Number(res.headers?.get("content-length"));
    const totalBytes = Number.isSafeInteger(length) && length > 0 ? length : undefined;
    if (totalBytes !== undefined && totalBytes > maxBytes) throw new Error("update download exceeds the size limit");
    onProgress?.({ receivedBytes: 0, totalBytes });
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    const append = (value: Uint8Array): void => {
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) throw new Error("update download exceeds the size limit");
      chunks.push(Buffer.from(value));
      onProgress?.({ receivedBytes, totalBytes });
    };
    if (res.body) {
      const reader = res.body.getReader();
      try {
        for (;;) {
          throwIfCancelled(signal);
          const { done, value } = await reader.read();
          if (done) break;
          if (value) append(value);
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
    } else {
      append(new Uint8Array(await res.arrayBuffer()));
    }
    throwIfCancelled(signal);
    if (receivedBytes === 0) throw new Error("empty update download");
    if (totalBytes !== undefined && totalBytes !== receivedBytes && !res.headers?.get("content-encoding")) throw new Error("incomplete update download");
    return Buffer.concat(chunks, receivedBytes);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
