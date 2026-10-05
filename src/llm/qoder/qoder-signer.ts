import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isBunRuntime } from "../../os/bun-runtime.js";
import { QODER_SIGNER_GLUE_JS_BASE64 } from "./signer-glue.generated.js";
import {
  QODER_SIGNER_WASM_GZIP_BASE64,
  QODER_SIGNER_WASM_SHA256,
} from "./signer-wasm.generated.js";

export const QODER_CLIENT_TYPE = "5";
export const QODER_BUSINESS_PRODUCT = "cli";
export const QODER_BUSINESS_TYPE = "agent";
export const QODER_SCENE = "assistant";

export interface QoderSignedRequest {
  url: string;
  headers: Record<string, string>;
  body?: string | undefined;
}

export interface QoderSignerIdentity {
  machineId: string;
  cosyVersion: string;
  userInfo?: QoderUserInfo | undefined;
}

export interface QoderUserInfo {
  uid?: string | undefined;
  encryptUserInfo?: string | undefined;
  key?: string | undefined;
}

interface QoderRequestResult {
  url: string;
  headers: { forEach(cb: (value: string, key: string) => void): void };
  body: Uint8Array | string | undefined;
}

interface QoderContextHandle {
  prepareRequest(
    endpoint: string,
    path: string,
    method: string,
    authType: string,
    body: string | undefined,
    headers: string | undefined,
  ): QoderRequestResult;
  prepareInferRequest(
    baseUrl: string,
    body: string,
    modelKey: string,
    modelSource: string,
  ): QoderRequestResult;
  get_external_providers_access(): string;
  free(): void;
}

export interface QoderGlueModule {
  default(options: { module_or_path: Uint8Array }): Promise<unknown>;
  QoderContext: new (
    machineId: string,
    cosyVersion: string,
    userInfoJson: string,
    envJson: string,
  ) => QoderContextHandle;
  credential_storage_decrypt(data: string, key: string): Uint8Array | string;
  decrypt_server_response(data: string): string;
  generate_runtime_auth_fields(userInfoJson: string): string;
}

let runtimePromise: Promise<QoderGlueModule> | undefined;

function signerWasmBytes(): Uint8Array {
  const bytes = new Uint8Array(
    gunzipSync(Buffer.from(QODER_SIGNER_WASM_GZIP_BASE64, "base64")),
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== QODER_SIGNER_WASM_SHA256) {
    throw new Error("qoder signer wasm failed its integrity check");
  }
  return bytes;
}

function loadSignerRuntime(): Promise<QoderGlueModule> {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const source = Buffer.from(QODER_SIGNER_GLUE_JS_BASE64, "base64").toString("utf8");
    const module = await importSignerGlue(source);
    await module.default({ module_or_path: signerWasmBytes() });
    return module;
  })().catch((error) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}

async function importSignerGlue(source: string): Promise<QoderGlueModule> {
  if (!isBunRuntime()) {
    return await import(`data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`) as QoderGlueModule;
  }
  const directory = await mkdtemp(join(tmpdir(), "clai-qoder-signer-"));
  try {
    const file = join(directory, "signer.mjs");
    await writeFile(file, source, { mode: 0o600, flag: "wx" });
    return await import(pathToFileURL(file).href) as QoderGlueModule;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function loadSignerModule(): Promise<QoderGlueModule> {
  return loadSignerRuntime();
}

export function qoderUserInfoJson(info?: QoderUserInfo | undefined): string {
  return JSON.stringify({
    uid: info?.uid ?? "",
    encrypt_user_info: info?.encryptUserInfo ?? "",
    key: info?.key ?? "",
  });
}

export function qoderEnvJson(): string {
  return JSON.stringify({
    client_type: QODER_CLIENT_TYPE,
    business_product: QODER_BUSINESS_PRODUCT,
    business_type: QODER_BUSINESS_TYPE,
    scene: QODER_SCENE,
  });
}

function headersToRecord(result: QoderRequestResult): Record<string, string> {
  const out: Record<string, string> = {};
  result.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function bodyToText(body: Uint8Array | string | undefined): string | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string") return body.length > 0 ? body : undefined;
  return body.length > 0 ? new TextDecoder().decode(body) : undefined;
}

function toSignedRequest(result: QoderRequestResult): QoderSignedRequest {
  const text = bodyToText(result.body);
  return {
    url: result.url,
    headers: headersToRecord(result),
    ...(text !== undefined ? { body: text } : {}),
  };
}

export class QoderSigner {
  private constructor(private readonly context: QoderContextHandle) {}

  static async create(identity: QoderSignerIdentity): Promise<QoderSigner> {
    const { QoderContext } = await loadSignerRuntime();
    const context = new QoderContext(
      identity.machineId,
      identity.cosyVersion,
      qoderUserInfoJson(identity.userInfo),
      qoderEnvJson(),
    );
    return new QoderSigner(context);
  }

  prepare(request: {
    endpoint: string;
    path: string;
    method: string;
    authType: string;
    body?: string | undefined;
    headers?: Record<string, string> | undefined;
  }): QoderSignedRequest {
    return toSignedRequest(
      this.context.prepareRequest(
        request.endpoint,
        request.path,
        request.method,
        request.authType,
        request.body,
        request.headers ? JSON.stringify(request.headers) : undefined,
      ),
    );
  }

  prepareInfer(request: {
    baseUrl: string;
    body: string;
    modelKey: string;
    modelSource?: string | undefined;
  }): QoderSignedRequest {
    return toSignedRequest(
      this.context.prepareInferRequest(
        request.baseUrl,
        request.body,
        request.modelKey,
        request.modelSource ?? "system",
      ),
    );
  }

  externalProvidersAccess(): string {
    return this.context.get_external_providers_access();
  }

  free(): void {
    try {
      this.context.free();
    } catch {
      // Context was already released by a failed prepare; ignore.
    }
  }
}
