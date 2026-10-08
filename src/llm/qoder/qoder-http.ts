import { hostname } from "node:os";
import { readBodyCapped } from "../wire/response-errors.js";
import { QODER_CLI_VERSION } from "./qoder-auth.js";
import type { QoderCredential } from "./qoder-credential.js";
import { QoderSigner } from "./qoder-signer.js";

export function qoderTransportHeaders(
  credential: QoderCredential,
  signedHeaders: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...signedHeaders,
    "Cosy-MachineToken": credential.machineToken,
    ...(credential.machineType ? { "Cosy-MachineType": credential.machineType } : {}),
    "Cosy-MachineHostname": hostname(),
  };
  for (const key of Object.keys(headers)) {
    if (["connection", "cache-control", "accept-encoding", "content-length"].includes(key.toLowerCase())) delete headers[key];
  }
  return headers;
}

export function qoderRequestSignal(signal?: AbortSignal, timeoutMs = 30_000): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function readQoderResponseBody(response: Response, signal?: AbortSignal): Promise<string> {
  return readBodyCapped(response, 65_536, signal);
}

export async function fetchQoderInference(url: string, init: RequestInit): Promise<Response> {
  init.signal?.throwIfAborted();
  const controller = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new DOMException("Qoder request timed out before any response.", "TimeoutError")), 30_000);
  try {
    return await fetch(url, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSignedQoderRequest(credential: QoderCredential, request: {
  endpoint: string;
  path: string;
  method: "GET" | "POST";
  body?: string | undefined;
  headers?: Record<string, string> | undefined;
  signal: AbortSignal;
}): Promise<Response> {
  request.signal.throwIfAborted();
  const signer = await QoderSigner.create({ machineId: credential.machineId, cosyVersion: QODER_CLI_VERSION, userInfo: credential });
  try {
    const signed = signer.prepare({ ...request, authType: "auth" });
    const url = signed.url.startsWith("http") ? signed.url : `${request.endpoint}${signed.url}`;
    const body = signed.body ?? request.body;
    return await fetch(url, {
      method: request.method,
      headers: { ...qoderTransportHeaders(credential, signed.headers), ...request.headers },
      ...(body !== undefined ? { body } : {}),
      signal: request.signal,
    });
  } finally {
    signer.free();
  }
}
