import type {
  EndpointId, Frontier, InvalidEndpointIdError, InvalidFrontierError,
  InvalidHashError, Limits, Message, MessageHash, RegisteredMessage, Result,
} from "./types.js";

export const DEFAULT_LIMITS: Limits = Object.freeze({
  maxIdBytes: 1024,
  maxContentTypeBytes: 1024,
  maxContentBytes: 1024 * 1024,
  maxEnvelopeBytes: 2 * 1024 * 1024,
  maxFrontierEntries: 1024,
  maxPageMessages: 1000,
  maxPageBytes: 16 * 1024 * 1024,
  maxHistoryNodes: 100_000,
  maxNodeReads: 1_000_000,
  scanBatchSize: 128,
  cacheSize: 256,
});

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}
export function err<E>(error: E): { readonly ok: false; readonly error: E } {
  return { ok: false, error };
}
export function scalarString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
export function parseEndpointId(value: string): Result<EndpointId, InvalidEndpointIdError> {
  return scalarString(value) ? ok(value as EndpointId) : err({ code: "INVALID_ENDPOINT_ID" });
}
export function parseMessageHash(value: string): Result<MessageHash, InvalidHashError> {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
    ? ok(value as MessageHash) : err({ code: "INVALID_HASH" });
}
export function createFrontier(
  entries: Iterable<readonly [EndpointId, MessageHash]> = [],
): Result<Frontier, InvalidFrontierError> {
  const frontier = new Map<EndpointId, MessageHash>();
  if (!entries || typeof entries[Symbol.iterator] !== "function") {
    return err({ code: "INVALID_FRONTIER", reason: "Expected iterable entries" });
  }
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return err({ code: "INVALID_FRONTIER", reason: "Expected endpoint/hash pairs" });
    }
    const [endpoint, hash] = entry;
    if (!parseEndpointId(endpoint).ok || !parseMessageHash(hash).ok || frontier.has(endpoint)) {
      return err({ code: "INVALID_FRONTIER", reason: "Invalid or duplicate frontier entry" });
    }
    frontier.set(endpoint, hash);
  }
  return ok(frontier);
}
export function copyMessage(message: Message): Message {
  return {
    endpointId: message.endpointId, frontier: new Map(message.frontier),
    contentType: message.contentType, content: new Uint8Array(message.content),
  };
}
export function copyRegistered(message: RegisteredMessage): RegisteredMessage {
  return { ...copyMessage(message), hash: message.hash, sequence: message.sequence };
}
export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
export function sequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
