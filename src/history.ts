import type { EndpointId, Frontier, Limits, MessageHash, PersistenceStrategy, RegisteredMessage } from "./types.js";
import { encodeMessage, hashMessage } from "./codec.js";
import { fail } from "./failure.js";
import { copyRegistered, parseMessageHash, sequence } from "./values.js";

export function contract(operation: string, reason: string): never {
  return fail({ code: "STRATEGY_CONTRACT", operation, reason });
}
export function badHistory(
  reason: "encoding" | "hash-mismatch" | "missing-dependency" | "fork"
    | "registration" | "causal-declaration" | "hash-collision",
  description: string, hashes: readonly MessageHash[] = [],
): never {
  return fail({ code: "INVALID_HISTORY", reason, description, hashes });
}

export class History {
  readonly tips = new Map<EndpointId, MessageHash>();
  readonly cache = new Map<MessageHash, RegisteredMessage>();
  private reads = 0;

  constructor(
    readonly strategy: PersistenceStrategy, readonly limits: Limits, readonly boundary: number,
  ) {}

  private count(): void {
    this.reads++;
    if (this.reads > this.limits.maxNodeReads) {
      fail({ code: "LIMIT_EXCEEDED", limit: "maxNodeReads", maximum: this.limits.maxNodeReads, actual: this.reads });
    }
  }

  async verify(message: RegisteredMessage): Promise<RegisteredMessage> {
    if (!sequence(message?.sequence) || message.sequence === 0 || !parseMessageHash(message?.hash).ok) {
      badHistory("registration", "Invalid sequence or hash");
    }
    const encoded = encodeMessage(message, this.limits);
    if (!encoded.ok) {
      if (encoded.error.code === "LIMIT_EXCEEDED") fail(encoded.error);
      badHistory("encoding", "Invalid stored message", [message.hash]);
    }
    const copied = copyRegistered(message);
    const digest = await hashMessage(copied, this.limits);
    if (!digest.ok) {
      if (digest.error.code === "HASH_CALCULATION" || digest.error.code === "LIMIT_EXCEEDED") fail(digest.error);
      badHistory("encoding", "Invalid stored message", [message.hash]);
    }
    if (digest.value !== copied.hash) badHistory("hash-mismatch", "Stored hash does not match content", [copied.hash]);
    return copied;
  }

  private remember(message: RegisteredMessage): void {
    this.cache.delete(message.hash);
    this.cache.set(message.hash, message);
    if (this.cache.size > this.limits.cacheSize) this.cache.delete(this.cache.keys().next().value!);
  }

  async get(hash: MessageHash): Promise<RegisteredMessage | undefined> {
    this.count();
    const cached = this.cache.get(hash);
    if (cached) return cached;
    const result = await this.strategy.get(hash);
    if (!result.ok) {
      if (result.error.code === "STORAGE_READ") fail(result.error);
      contract("get", "Strategy rejected a valid hash");
    }
    if (!result.value) return undefined;
    const message = await this.verify(result.value);
    if (message.hash !== hash) contract("get", "Returned a different hash");
    this.remember(message);
    return message;
  }

  async ancestor(endpoint: EndpointId, ancestor: MessageHash, descendant: MessageHash | undefined): Promise<boolean> {
    if (!descendant) return false;
    let cursor: MessageHash | undefined = descendant;
    let upper = Number.POSITIVE_INFINITY;
    while (cursor) {
      const node = await this.get(cursor);
      if (!node) badHistory("missing-dependency", "Ancestor path is missing a node", [cursor]);
      if (node.endpointId !== endpoint) badHistory("causal-declaration", "Ancestor belongs to another endpoint", [cursor]);
      if (node.sequence >= upper || node.sequence > this.boundary) {
        badHistory("registration", "Dependency sequence is not earlier", [cursor]);
      }
      if (cursor === ancestor) return true;
      upper = node.sequence;
      cursor = node.frontier.get(endpoint);
    }
    return false;
  }

  async closed(frontier: Frontier, stored: boolean): Promise<void> {
    for (const [endpoint, hash] of frontier) {
      const referenced = await this.get(hash);
      if (!referenced || referenced.sequence > this.boundary) {
        if (stored) badHistory("missing-dependency", "Missing registered dependency", [hash]);
        fail({ code: "UNKNOWN_REFERENCE", hash });
      }
      if (referenced.endpointId !== endpoint) {
        if (stored) badHistory("causal-declaration", "Reference endpoint mismatch", [hash]);
        fail({ code: "REFERENCE_ENDPOINT_MISMATCH", hash, expected: endpoint, actual: referenced.endpointId });
      }
      for (const [requiredEndpoint, required] of referenced.frontier) {
        const declared = frontier.get(requiredEndpoint);
        if (!await this.ancestor(requiredEndpoint, required, declared)) {
          if (stored) badHistory("causal-declaration", "Stored frontier is not closed", [hash]);
          fail({ code: "FRONTIER_NOT_CLOSED", endpointId: requiredEndpoint, required, declared: declared ?? null });
        }
      }
    }
  }

  async *scan(): AsyncGenerator<RegisteredMessage> {
    let after = 0;
    let scanned = 0;
    while (after < this.boundary) {
      const result = await this.strategy.scan({
        afterSequence: after, throughSequence: this.boundary, limit: this.limits.scanBatchSize,
      });
      if (!result.ok) {
        if (result.error.code === "STORAGE_READ") fail(result.error);
        contract("scan", "Strategy rejected a valid range");
      }
      if (!Array.isArray(result.value) || result.value.length > this.limits.scanBatchSize) {
        contract("scan", "Invalid batch");
      }
      if (result.value.length === 0) contract("scan", "Missing committed high-water record");
      for (const raw of result.value) {
        this.count();
        scanned++;
        if (scanned > this.limits.maxHistoryNodes) {
          fail({ code: "LIMIT_EXCEEDED", limit: "maxHistoryNodes", maximum: this.limits.maxHistoryNodes, actual: scanned });
        }
        const message = await this.verify(raw);
        if (message.sequence <= after || message.sequence > this.boundary) contract("scan", "Unordered or out-of-range sequence");
        after = message.sequence;
        this.remember(message);
        yield message;
      }
    }
  }

  async load(): Promise<void> {
    const hashes = new Set<MessageHash>();
    for await (const message of this.scan()) {
      if (hashes.has(message.hash)) badHistory("registration", "Node registered more than once", [message.hash]);
      hashes.add(message.hash);
      const previous = this.tips.get(message.endpointId);
      for (const [endpoint, hash] of message.frontier) {
        const dependency = await this.get(hash);
        if (!dependency) badHistory("missing-dependency", "Missing dependency", [message.hash, hash]);
        if (dependency.endpointId !== endpoint) badHistory("causal-declaration", "Dependency endpoint mismatch", [message.hash, hash]);
        if (dependency.sequence >= message.sequence) badHistory("registration", "Dependency must be registered first", [message.hash, hash]);
      }
      const declaredPredecessor = message.frontier.get(message.endpointId);
      if (declaredPredecessor !== previous) {
        let conflicting = previous;
        let steps = 0;
        while (conflicting && ++steps <= this.limits.maxNodeReads) {
          const node = await this.get(conflicting);
          if (!node) badHistory("missing-dependency", "Missing fork evidence", [conflicting]);
          const parent = node.frontier.get(message.endpointId);
          if (parent === declaredPredecessor || !parent) break;
          conflicting = parent;
        }
        fail({
          code: "INVALID_HISTORY", reason: "fork", description: "Endpoint has conflicting successors",
          hashes: conflicting ? [conflicting, message.hash] : [message.hash],
          endpointId: message.endpointId, predecessor: declaredPredecessor ?? null,
        });
      }
      if (previous) {
        const prior = await this.get(previous);
        if (!prior) badHistory("missing-dependency", "Missing previous message", [previous]);
        for (const [endpoint, required] of prior.frontier) {
          if (!await this.ancestor(endpoint, required, message.frontier.get(endpoint))) {
            badHistory("causal-declaration", "Stored observation regressed", [message.hash, previous]);
          }
        }
      }
      await this.closed(message.frontier, true);
      this.tips.set(message.endpointId, message.hash);
    }
  }
}

export async function latest(strategy: PersistenceStrategy): Promise<number> {
  const result = await strategy.getLatestSequence();
  if (!result.ok) fail(result.error);
  if (!sequence(result.value)) contract("getLatestSequence", "Invalid committed high-water sequence");
  return result.value;
}
