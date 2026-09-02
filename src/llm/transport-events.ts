export type TransportEventKind =
  | "responses-fallback-endpoint"
  | "responses-fallback-shape"
  | "responses-fallback-error"
  | "responses-fallback-reasoning"
  | "responses-downgrade-extras"
  | "responses-eof-accepted";

export interface TransportEvent {
  readonly kind: TransportEventKind;
  readonly provider: string;
  readonly model: string;
  readonly detail?: string | undefined;
}

type TransportListener = (event: TransportEvent) => void;

const listeners = new Set<TransportListener>();
const emittedKeys = new Set<string>();

function eventKey(event: TransportEvent): string {
  return `${event.kind}:${event.provider}:${event.model.toLowerCase()}`;
}

export function onTransportEvent(listener: TransportListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitTransportEvent(event: TransportEvent): void {
  const key = eventKey(event);
  if (emittedKeys.has(key)) return;
  emittedKeys.add(key);
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      continue;
    }
  }
}

export function resetTransportEventsForTesting(): void {
  emittedKeys.clear();
}
