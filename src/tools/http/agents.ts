import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { Agent } from "undici";

let insecureTlsAgent: Agent | undefined;

export function getInsecureTlsAgent(): Agent {
  if (!insecureTlsAgent) {
    insecureTlsAgent = new Agent({
      connect: {
        rejectUnauthorized: false,
      },
    });
  }
  return insecureTlsAgent;
}

type PinnedLookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * Pin Fetch to addresses that already passed policy so the connection uses
 * the same DNS answer the policy check saw. Without pre-resolved addresses
 * the dispatcher resolves the hostname itself.
 */
export function createPinnedAgent(
  addresses: readonly string[],
  insecureTls: boolean,
): Agent {
  const preResolved = toLookupAddresses(addresses);
  return new Agent({
    connect: {
      rejectUnauthorized: !insecureTls,
      lookup: (
        hostname: string,
        options: LookupOptions,
        callback: PinnedLookupCallback,
      ): void => {
        const send = (resolved: LookupAddress[]): void => {
          if (resolved.length === 0) {
            callback(new Error(`DNS resolution returned no addresses for ${hostname}`), "");
            return;
          }
          if (options && typeof options === "object" && options.all === true) {
            callback(null, resolved);
            return;
          }
          const selected = resolved[0]!;
          callback(null, selected.address, selected.family);
        };

        if (preResolved.length > 0) {
          send(preResolved);
          return;
        }
        void lookup(hostname, { all: true }).then(
          (results) => send(toLookupAddresses(results.map((entry) => entry.address))),
          (error: unknown) =>
            callback(
              error instanceof Error ? error : new Error(String(error)),
              "",
            ),
        );
      },
    },
  });
}

function toLookupAddresses(addresses: readonly string[]): LookupAddress[] {
  return addresses
    .map((address) => ({ address, family: net.isIP(address) }))
    .filter((entry): entry is LookupAddress => entry.family === 4 || entry.family === 6);
}

export async function closeAgents(agents: readonly Agent[]): Promise<void> {
  await Promise.allSettled(agents.map(async (agent) => agent.close()));
}
