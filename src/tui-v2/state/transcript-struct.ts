/**
 * Structural helpers for normalized transcript state: append-only order
 * proxies and byId maps (shared by the pure transcript reducer).
 */

import type { TranscriptItem, TranscriptState } from "./transcript-types.js";

interface OrderNode {
  readonly parent: OrderNode | undefined;
  readonly base: readonly string[] | undefined;
  readonly item: string;
  cache: readonly string[] | undefined;
}

const orderNodes = new WeakMap<object, OrderNode>();

function resolveOrder(node: OrderNode): readonly string[] {
  if (node.cache) return node.cache;
  const nodes: OrderNode[] = [];
  let current: OrderNode | undefined = node;
  while (current && !current.cache) {
    nodes.push(current);
    current = current.parent;
  }
  const values = current?.cache ? [...current.cache] : [...(nodes.at(-1)?.base ?? [])];
  for (let index = nodes.length - 1; index >= 0; index -= 1) values.push(nodes[index]!.item);
  node.cache = values;
  return values;
}

function appendOrder(order: readonly string[], item: string): readonly string[] {
  const parent = orderNodes.get(order as object);
  const node: OrderNode = { parent, base: parent ? undefined : order, item, cache: undefined };
  const proxy = new Proxy([] as string[], {
    get(_target, property) {
      const values = resolveOrder(node);
      const value = Reflect.get(values, property, values);
      return typeof value === "function" ? value.bind(values) : value;
    },
  });
  orderNodes.set(proxy, node);
  return proxy;
}

interface MapNode {
  readonly parent: MapNode | undefined;
  readonly base: ReadonlyMap<string, TranscriptItem> | undefined;
  readonly key: string;
  readonly value: TranscriptItem;
  cache: ReadonlyMap<string, TranscriptItem> | undefined;
}

class AppendedMap implements ReadonlyMap<string, TranscriptItem> {
  readonly [Symbol.toStringTag] = "Map";

  constructor(readonly node: MapNode) {}

  get size(): number {
    return this.resolve().size;
  }

  get(key: string): TranscriptItem | undefined {
    return this.resolve().get(key);
  }

  has(key: string): boolean {
    return this.resolve().has(key);
  }

  entries(): MapIterator<[string, TranscriptItem]> {
    return this.resolve().entries();
  }

  keys(): MapIterator<string> {
    return this.resolve().keys();
  }

  values(): MapIterator<TranscriptItem> {
    return this.resolve().values();
  }

  forEach(
    callbackfn: (value: TranscriptItem, key: string, map: ReadonlyMap<string, TranscriptItem>) => void,
    thisArg?: unknown,
  ): void {
    this.resolve().forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }

  [Symbol.iterator](): MapIterator<[string, TranscriptItem]> {
    return this.entries();
  }

  private resolve(): ReadonlyMap<string, TranscriptItem> {
    if (this.node.cache) return this.node.cache;
    const nodes: MapNode[] = [];
    let current: MapNode | undefined = this.node;
    while (current && !current.cache) {
      nodes.push(current);
      current = current.parent;
    }
    const values = new Map(current?.cache ?? nodes.at(-1)?.base);
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index]!;
      values.set(node.key, node.value);
    }
    this.node.cache = values;
    return values;
  }
}

function appendById(
  byId: ReadonlyMap<string, TranscriptItem>,
  key: string,
  value: TranscriptItem,
): ReadonlyMap<string, TranscriptItem> {
  const parent = byId instanceof AppendedMap ? byId.node : undefined;
  return new AppendedMap({ parent, base: parent ? undefined : byId, key, value, cache: undefined });
}

export function appendItem(state: TranscriptState, item: TranscriptItem): TranscriptState {
  return {
    ...state,
    order: appendOrder(state.order, item.id),
    byId: appendById(state.byId, item.id, item),
  };
}

export function updateItem(
  state: TranscriptState,
  id: string,
  update: (item: TranscriptItem) => TranscriptItem,
): TranscriptState {
  const existing = state.byId.get(id);
  if (!existing) return state;
  const byId = new Map(state.byId);
  byId.set(id, update(existing));
  return { ...state, byId };
}

export function removeItem(state: TranscriptState, id: string): TranscriptState {
  if (!state.byId.has(id)) return state;
  const byId = new Map(state.byId);
  byId.delete(id);
  return {
    ...state,
    byId,
    order: state.order.filter((entry) => entry !== id),
  };
}

/**
 * Move `itemId` so it sits immediately before `beforeId` in display order.
 * No-op when either id is missing or the item already precedes `beforeId`.
 * Used to keep thinking → response → tools order when reasoning is finalized
 * after assistant prose already opened a row.
 */
export function moveItemBefore(
  state: TranscriptState,
  itemId: string,
  beforeId: string,
): TranscriptState {
  if (itemId === beforeId) return state;
  const from = state.order.indexOf(itemId);
  const to = state.order.indexOf(beforeId);
  if (from < 0 || to < 0 || from < to) return state;
  const order = state.order.slice();
  order.splice(from, 1);
  const insertAt = order.indexOf(beforeId);
  if (insertAt < 0) return state;
  order.splice(insertAt, 0, itemId);
  return { ...state, order };
}
