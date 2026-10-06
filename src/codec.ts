import type {
  HashCalculationError, InvalidFrontierError, InvalidMessageError, LimitExceededError,
  Limits, Message, MessageHash, Result,
} from "./types.js";
import { DEFAULT_LIMITS, err, ok, parseEndpointId, parseMessageHash, sameBytes, scalarString } from "./values.js";

export interface InvalidEncodingError {
  readonly code: "INVALID_ENCODING";
  readonly offset: number;
  readonly reason: string;
}
export type EncodeError = InvalidMessageError | InvalidFrontierError | LimitExceededError;
export type DecodeError = InvalidEncodingError | LimitExceededError;

const encoder = new TextEncoder();
const prefix = encoder.encode("causal-weave\0");

function exceeded(limit: keyof Limits, actual: number, limits: Limits): LimitExceededError | undefined {
  return actual > limits[limit]
    ? { code: "LIMIT_EXCEEDED", limit, actual, maximum: limits[limit] } : undefined;
}

export function validateFrontier(frontier: Message["frontier"], limits: Limits): Result<void, InvalidFrontierError | LimitExceededError> {
  if (!(frontier instanceof Map)) {
    return err({ code: "INVALID_FRONTIER", reason: "Frontier must be a Map" });
  }
  const countIssue = exceeded("maxFrontierEntries", frontier.size, limits);
  if (countIssue) return err(countIssue);
  for (const [endpoint, hash] of frontier) {
    if (!scalarString(endpoint) || !parseMessageHash(hash).ok) {
      return err({ code: "INVALID_FRONTIER", reason: "Invalid frontier entry" });
    }
    const issue = exceeded("maxIdBytes", endpoint.length, limits)
      ?? exceeded("maxIdBytes", encoder.encode(endpoint).length, limits);
    if (issue) return err(issue);
  }
  return ok(undefined);
}

export function validateMessage(message: Message, limits: Limits = DEFAULT_LIMITS): Result<void, EncodeError> {
  if (!message || !scalarString(message.endpointId) || !scalarString(message.contentType)
    || !(message.content instanceof Uint8Array)) {
    return err({ code: "INVALID_MESSAGE", field: "message", reason: "Invalid endpoint, content type or bytes" });
  }
  const frontier = validateFrontier(message.frontier, limits);
  if (!frontier.ok) return frontier;
  const issue = exceeded("maxIdBytes", message.endpointId.length, limits)
    ?? exceeded("maxIdBytes", encoder.encode(message.endpointId).length, limits)
    ?? exceeded("maxContentTypeBytes", message.contentType.length, limits)
    ?? exceeded("maxContentTypeBytes", encoder.encode(message.contentType).length, limits)
    ?? exceeded("maxContentBytes", message.content.length, limits);
  return issue ? err(issue) : ok(undefined);
}

function byteOrder(left: Uint8Array, right: Uint8Array): number {
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i]! - right[i]!;
    if (difference) return difference;
  }
  return left.length - right.length;
}

export function encodeMessage(message: Message, limits: Limits = DEFAULT_LIMITS): Result<Uint8Array, EncodeError> {
  const valid = validateMessage(message, limits);
  if (!valid.ok) return valid;
  const endpoint = encoder.encode(message.endpointId);
  const contentType = encoder.encode(message.contentType);
  const entries = [...message.frontier].map(([id, hash]) => ({ id: encoder.encode(id), hash }));
  entries.sort((left, right) => byteOrder(left.id, right.id));
  const length = prefix.length + 4 + endpoint.length + 4
    + entries.reduce((sum, entry) => sum + 4 + entry.id.length + 32, 0)
    + 4 + contentType.length + 4 + message.content.length;
  const issue = exceeded("maxEnvelopeBytes", length, limits);
  if (issue) return err(issue);
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  const raw = (value: Uint8Array) => { bytes.set(value, offset); offset += value.length; };
  const u32 = (value: number) => { view.setUint32(offset, value); offset += 4; };
  const field = (value: Uint8Array) => { u32(value.length); raw(value); };
  raw(prefix);
  field(endpoint);
  u32(entries.length);
  for (const entry of entries) {
    field(entry.id);
    raw(Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(entry.hash.slice(index * 2, index * 2 + 2), 16)));
  }
  field(contentType);
  field(message.content);
  return ok(bytes);
}

class DecodeFailure extends Error {
  constructor(readonly error: DecodeError) { super(error.code); }
}

export function decodeMessage(bytes: Uint8Array, limits: Limits = DEFAULT_LIMITS): Result<Message, DecodeError> {
  if (!(bytes instanceof Uint8Array)) return err({ code: "INVALID_ENCODING", offset: 0, reason: "Expected bytes" });
  const issue = exceeded("maxEnvelopeBytes", bytes.length, limits);
  if (issue) return err(issue);
  const input = new Uint8Array(bytes);
  const view = new DataView(input.buffer);
  let offset = 0;
  const fail = (reason: string): never => {
    throw new DecodeFailure({ code: "INVALID_ENCODING", offset, reason });
  };
  const raw = (length: number): Uint8Array => {
    if (length > input.length - offset) fail("Truncated field");
    const value = input.slice(offset, offset + length);
    offset += length;
    return value;
  };
  const u32 = () => {
    if (input.length - offset < 4) fail("Truncated length");
    const value = view.getUint32(offset);
    offset += 4;
    return value;
  };
  const field = (limit: keyof Limits) => {
    const length = u32();
    const error = exceeded(limit, length, limits);
    if (error) throw new DecodeFailure(error);
    return raw(length);
  };
  const text = (value: Uint8Array) => {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
    } catch (error) {
      if (error instanceof TypeError) return fail("Invalid UTF-8");
      throw error;
    }
  };
  try {
    if (!sameBytes(raw(prefix.length), prefix)) fail("Invalid domain prefix");
    const endpoint = parseEndpointId(text(field("maxIdBytes")));
    if (!endpoint.ok) return fail("Invalid endpoint");
    const count = u32();
    const tooMany = exceeded("maxFrontierEntries", count, limits);
    if (tooMany) throw new DecodeFailure(tooMany);
    const frontier = new Map<Message["endpointId"], MessageHash>();
    let previous: Uint8Array | undefined;
    for (let index = 0; index < count; index++) {
      const idBytes = field("maxIdBytes");
      if (previous && byteOrder(previous, idBytes) >= 0) fail("Keys must be strictly byte-sorted");
      previous = idBytes;
      const id = parseEndpointId(text(idBytes));
      if (!id.ok) return fail("Invalid frontier endpoint");
      const hash = parseMessageHash([...raw(32)].map(byte => byte.toString(16).padStart(2, "0")).join(""));
      if (!hash.ok) return fail("Invalid hash");
      frontier.set(id.value, hash.value);
    }
    const contentType = text(field("maxContentTypeBytes"));
    if (!scalarString(contentType)) fail("Invalid content type");
    const content = field("maxContentBytes");
    if (offset !== input.length) fail("Trailing bytes");
    return ok({ endpointId: endpoint.value, frontier, contentType, content });
  } catch (error) {
    if (error instanceof DecodeFailure) return err(error.error);
    throw error;
  }
}

export async function hashMessage(
  message: Message, limits: Limits = DEFAULT_LIMITS,
): Promise<Result<MessageHash, EncodeError | HashCalculationError>> {
  const encoded = encodeMessage(message, limits);
  if (!encoded.ok) return encoded;
  if (!globalThis.crypto?.subtle) return err({ code: "HASH_CALCULATION", reason: "unavailable" });
  try {
    const buffer = new Uint8Array(encoded.value).buffer;
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", buffer));
    const parsed = parseMessageHash([...digest].map(byte => byte.toString(16).padStart(2, "0")).join(""));
    if (!parsed.ok) throw new Error("SHA-256 returned an invalid digest");
    return parsed;
  } catch (error) {
    if (error instanceof DOMException) {
      return err({ code: "HASH_CALCULATION", reason: "failed", cause: error });
    }
    throw error;
  }
}
