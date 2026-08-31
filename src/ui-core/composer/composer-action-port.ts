
type Handler = () => void;
type DraftListener = (hasDraft: boolean) => void;

type InsertHandler = (text: string) => void;

let clearHandler: Handler | undefined;
let cutHandler: Handler | undefined;
let openCommandsHandler: Handler | undefined;
let insertHandler: InsertHandler | undefined;
let hasDraft = false;
const draftListeners = new Set<DraftListener>();

function register(
  handler: Handler,
  assign: (next: Handler | undefined) => void,
  current: () => Handler | undefined,
): () => void {
  assign(handler);
  return () => {
    if (current() === handler) assign(undefined);
  };
}

export const composerActionPort = {
  registerClear(handler: Handler): () => void {
    return register(
      handler,
      (next) => {
        clearHandler = next;
      },
      () => clearHandler,
    );
  },
  clear(): void {
    clearHandler?.();
  },
  registerCut(handler: Handler): () => void {
    return register(
      handler,
      (next) => {
        cutHandler = next;
      },
      () => cutHandler,
    );
  },
  cut(): void {
    cutHandler?.();
  },
  registerOpenCommands(handler: Handler): () => void {
    return register(
      handler,
      (next) => {
        openCommandsHandler = next;
      },
      () => openCommandsHandler,
    );
  },
  openCommands(): void {
    openCommandsHandler?.();
  },
  registerInsert(handler: InsertHandler): () => void {
    insertHandler = handler;
    return () => {
      if (insertHandler === handler) insertHandler = undefined;
    };
  },
  insert(text: string): boolean {
    if (!insertHandler) return false;
    insertHandler(text);
    return true;
  },
  setHasDraft(next: boolean): void {
    if (next === hasDraft) return;
    hasDraft = next;
    for (const listener of draftListeners) listener(next);
  },
  hasDraft(): boolean {
    return hasDraft;
  },
  subscribeDraft(listener: DraftListener): () => void {
    draftListeners.add(listener);
    return () => draftListeners.delete(listener);
  },
};
