export type ResumeTarget =
  | { readonly kind: "latest"; readonly scope?: "global" | undefined }
  | { readonly kind: "id"; readonly id: string };

export function resolveResumeOption(options: {
  resume?: string | boolean | undefined;
  continue?: boolean | undefined;
}): ResumeTarget | undefined {
  if (typeof options.resume === "string" && options.resume.trim()) {
    return { kind: "id", id: options.resume.trim() };
  }
  if (options.resume) return { kind: "latest", scope: "global" };
  return options.continue ? { kind: "latest" } : undefined;
}
