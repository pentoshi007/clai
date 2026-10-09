const [mode, target, issuer] = process.argv.slice(2);

if (mode === "config") {
  const { writeProjectMcpServer } = await import("../../../src/mcp/config-file.ts");
  for (let index = 0; index < 4; index++) {
    const result = await writeProjectMcpServer(
      JSON.stringify({ name: `${issuer}-${index}`, command: "docs-server" }),
      { workspaceFolder: target },
    );
    if (!result.ok) throw new Error(result.error);
  }
  process.stdout.write("saved");
} else if (mode === "refresh") {
  const { createAuthProvider } = await import("../../../src/mcp/auth/provider.ts");
  const provider = createAuthProvider(
    { kind: "oauth", authorizationServer: issuer },
    {
      serverUrl: target,
      interactive: false,
      validateUrl: (url) => new URL(url),
    },
  );
  process.stdout.write(JSON.stringify(await provider.headers()));
} else {
  throw new Error(`Unknown worker mode: ${mode}`);
}
