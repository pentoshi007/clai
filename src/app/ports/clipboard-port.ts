/**
 * Clipboard access (SEL-006). Copy requires user-visible selected text; the
 * real OSC 52 / native-clipboard adapter lands with the renderer in Phase 6.
 * The app-layer default is in-memory so nothing writes terminal bytes here.
 */
export interface ClipboardPort {
  writeText(text: string): Promise<void>;
  readText?(): Promise<string | undefined>;
}
