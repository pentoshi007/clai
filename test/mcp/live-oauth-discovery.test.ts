import { describe, expect, it } from "vitest";

const LIVE = process.env.CLAI_LIVE_OAUTH_CHECK === "1";

const targets = [
  { name: "notion", url: "https://mcp.notion.com/mcp" },
  { name: "github", url: "https://api.githubcopilot.com/mcp/" },
] as const;

describe.runIf(LIVE)("live OAuth discovery for catalog servers", () => {
  for (const target of targets) {
    it(`${target.name} advertises a usable authorization path`, async () => {
      const prmUrl = new URL(target.url);
      const path = prmUrl.pathname === "/" ? "" : prmUrl.pathname;
      prmUrl.pathname = `/.well-known/oauth-protected-resource${path}`;
      const prm = (await fetch(prmUrl).then((r) => (r.ok ? r.json() : null))) as {
        authorization_servers?: string[];
      } | null;
      expect(prm?.authorization_servers?.length).toBeGreaterThan(0);

      const issuer = new URL(prm!.authorization_servers![0]!);
      const issuerPath = issuer.pathname.replace(/\/+$/, "");
      const base = `${issuer.protocol}//${issuer.host}`;
      const candidates = [
        `${base}/.well-known/oauth-authorization-server${issuerPath}`,
        `${base}/.well-known/openid-configuration${issuerPath}`,
        `${base}${issuerPath}/.well-known/openid-configuration`,
      ];
      let meta: {
        registration_endpoint?: string;
        device_authorization_endpoint?: string;
        code_challenge_methods_supported?: string[];
      } | null = null;
      for (const candidate of new Set(candidates)) {
        meta = (await fetch(candidate).then((r) => (r.ok ? r.json() : null))) as typeof meta;
        if (meta) break;
      }
      expect(meta).toBeTruthy();
      const usable =
        typeof meta!.registration_endpoint === "string" ||
        typeof meta!.device_authorization_endpoint === "string";
      expect(usable).toBe(true);
      expect(meta!.code_challenge_methods_supported ?? []).toContain("S256");
    });
  }
});
