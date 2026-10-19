import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  arch as osArch,
  cpus as osCpus,
  hostname as osHostname,
  networkInterfaces as osNetworkInterfaces,
  platform as osPlatform,
} from "node:os";
import { join } from "node:path";
import { normalizeFreebuffProcessName } from "./freebuff-env-profile.js";

export interface FreebuffNetworkInterface {
  readonly mac?: string | undefined;
  readonly internal?: boolean | undefined;
}

export interface FreebuffFingerprintDeps {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: string | undefined;
  readonly arch?: string | undefined;
  readonly nodeVersion?: string | undefined;
  readonly machineIdPaths?: readonly string[] | undefined;
  readonly dmiDir?: string | undefined;
  readonly cpuInfoPath?: string | undefined;
  readonly osReleasePath?: string | undefined;
  readonly readText?: ((path: string) => string | null) | undefined;
  readonly hostname?: (() => string) | undefined;
  readonly cpuCount?: (() => number) | undefined;
  readonly networkInterfaces?: (() => NodeJS.Dict<ReadonlyArray<FreebuffNetworkInterface>>) | undefined;
}

const DEFAULT_MACHINE_ID_PATHS = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
const DEFAULT_DMI_DIR = "/sys/class/dmi/id";
const DEFAULT_CPUINFO_PATH = "/proc/cpuinfo";
const DEFAULT_OS_RELEASE_PATH = "/etc/os-release";
const ZERO_MAC = "00:00:00:00:00:00";

export function createLegacyFreebuffFingerprintId(): string {
  return `codebuff-cli-${randomBytes(6).toString("base64url").substring(0, 8)}`;
}

function readTextDefault(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function machineIdOf(deps: FreebuffFingerprintDeps): string | null {
  const read = deps.readText ?? readTextDefault;
  for (const path of deps.machineIdPaths ?? DEFAULT_MACHINE_ID_PATHS) {
    const value = read(path)?.trim();
    if (value && value !== "unknown" && value.length >= 8) return value;
  }
  return null;
}

function dmiValue(deps: FreebuffFingerprintDeps, field: string): string {
  const read = deps.readText ?? readTextDefault;
  return read(join(deps.dmiDir ?? DEFAULT_DMI_DIR, field))?.trim() ?? "";
}

interface CpuDetails {
  readonly manufacturer: string;
  readonly brand: string;
  readonly physicalCores: number;
}

function parseCpuInfo(text: string): CpuDetails {
  let manufacturer = "";
  let brand = "";
  let physicalCores = 0;
  for (const line of text.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!value) continue;
    if (!manufacturer && (name === "vendor_id" || name === "CPU implementer")) manufacturer = value;
    if (!brand && (name === "model name" || name === "Processor" || name === "Hardware")) brand = value;
    if (!physicalCores && name === "cpu cores") {
      const cores = Number(value);
      if (Number.isSafeInteger(cores) && cores > 0) physicalCores = cores;
    }
  }
  return { manufacturer, brand, physicalCores };
}

function distroOf(deps: FreebuffFingerprintDeps): string {
  const read = deps.readText ?? readTextDefault;
  const release = read(deps.osReleasePath ?? DEFAULT_OS_RELEASE_PATH);
  if (!release) return "";
  const match = /^PRETTY_NAME=(.*)$/m.exec(release);
  return match?.[1]?.trim().replace(/^"|"$/g, "") ?? "";
}

function networkSnapshot(deps: FreebuffFingerprintDeps): {
  macAddresses: string[];
  interfaceCount: number;
} {
  const interfaces = deps.networkInterfaces
    ? deps.networkInterfaces()
    : (osNetworkInterfaces() as NodeJS.Dict<ReadonlyArray<FreebuffNetworkInterface>>);
  const macAddresses = Object.values(interfaces)
    .flatMap((entries) => (entries ?? []).filter((entry) => entry && !entry.internal && entry.mac && entry.mac !== ZERO_MAC))
    .map((entry) => entry.mac as string)
    .sort();
  return { macAddresses, interfaceCount: Object.keys(interfaces).length };
}

async function enhancedFreebuffFingerprintId(deps: FreebuffFingerprintDeps): Promise<string | null> {
  try {
    const machineId = machineIdOf(deps);
    if (!machineId) return null;
    const env = deps.env ?? process.env;
    const read = deps.readText ?? readTextDefault;
    const cpu = parseCpuInfo(read(deps.cpuInfoPath ?? DEFAULT_CPUINFO_PATH) ?? "");
    const platform = deps.platform ?? osPlatform();
    const network = networkSnapshot(deps);
    const profile = {
      system: {
        manufacturer: dmiValue(deps, "sys_vendor"),
        model: dmiValue(deps, "product_name"),
        serial: dmiValue(deps, "product_serial"),
        uuid: dmiValue(deps, "product_uuid"),
      },
      cpu: {
        manufacturer: cpu.manufacturer,
        brand: cpu.brand,
        cores: (deps.cpuCount ?? (() => osCpus().length))(),
        physicalCores: cpu.physicalCores,
      },
      os: {
        platform,
        distro: distroOf(deps),
        arch: deps.arch ?? osArch(),
        hostname: (deps.hostname ?? osHostname)(),
      },
      runtime: {
        nodeVersion: deps.nodeVersion ?? process.version,
        platform,
        arch: deps.arch ?? osArch(),
        shell: normalizeFreebuffProcessName(env.SHELL),
        cpuCount: (deps.cpuCount ?? (() => osCpus().length))(),
      },
      network,
      machineId,
      fingerprintVersion: "2.0",
    };
    const digest = createHash("sha256").update(JSON.stringify(profile)).digest("base64url");
    return `enhanced-${digest}`;
  } catch {
    return null;
  }
}

let cachedFingerprint: Promise<string> | undefined;

async function computeFreebuffFingerprintId(deps: FreebuffFingerprintDeps): Promise<string> {
  return (await enhancedFreebuffFingerprintId(deps)) ?? createLegacyFreebuffFingerprintId();
}

export function freebuffFingerprintId(deps: FreebuffFingerprintDeps = {}): Promise<string> {
  if (!cachedFingerprint) {
    cachedFingerprint = computeFreebuffFingerprintId(deps).catch(() => createLegacyFreebuffFingerprintId());
  }
  return cachedFingerprint;
}

export function resetFreebuffFingerprint(): void {
  cachedFingerprint = undefined;
}
