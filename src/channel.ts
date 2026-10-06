import type {
  Channel, ChannelObserver, ChannelOptions, Frontier, Limits, Message,
  PersistenceStrategy, ReadRequest, Result, WatchStartError, Unwatch,
} from "./types.js";
import { encodeMessage, hashMessage, validateFrontier, validateMessage } from "./codec.js";
import { capture, fail, readError, sendError, stateError } from "./failure.js";
import { History, badHistory, contract, latest } from "./history.js";
import { DEFAULT_LIMITS, copyMessage, copyRegistered, err, ok, sameBytes, sequence } from "./values.js";

function frontierShape(frontier: Frontier, limits: Limits): void {
  const checked = validateFrontier(frontier, limits);
  if (!checked.ok) fail(checked.error);
}

async function view(strategy: PersistenceStrategy, limits: Limits, boundary?: number): Promise<History> {
  const history = new History(strategy, limits, boundary ?? await latest(strategy));
  await history.load();
  return history;
}

class CausalChannel implements Channel {
  constructor(private readonly strategy: PersistenceStrategy, private readonly limits: Limits) {}

  send(input: Message): ReturnType<Channel["send"]> {
    return capture(async () => {
      const valid = validateMessage(input, this.limits);
      if (!valid.ok) fail(valid.error);
      const message = copyMessage(input);
      const digest = await hashMessage(message, this.limits);
      if (!digest.ok) fail(digest.error);
      const hash = digest.value;
      const history = await view(this.strategy, this.limits);
      const existing = await history.get(hash);
      if (existing && existing.sequence <= history.boundary) {
        const original = encodeMessage(existing, this.limits);
        const requested = encodeMessage(message, this.limits);
        if (!original.ok || !requested.ok) badHistory("encoding", "Invalid replay content", [hash]);
        if (!sameBytes(original.value, requested.value)) badHistory("hash-collision", "Same hash has different content", [hash]);
        if (!await history.ancestor(existing.endpointId, hash, history.tips.get(existing.endpointId))) {
          contract("get", "Replay node is not in the registered history");
        }
        return { message: copyRegistered(existing), currentFrontier: new Map(history.tips) };
      }
      for (const [endpoint, reference] of message.frontier) {
        const node = await history.get(reference);
        if (!node) fail({ code: "UNKNOWN_REFERENCE", hash: reference });
        if (node.endpointId !== endpoint) {
          fail({ code: "REFERENCE_ENDPOINT_MISMATCH", hash: reference, expected: endpoint, actual: node.endpointId });
        }
        if (node && node.sequence > history.boundary) {
          fail({ code: "CONCURRENT_MODIFICATION", expectedSequence: history.boundary, actualSequence: await latest(this.strategy) });
        }
      }
      const actualTip = history.tips.get(message.endpointId);
      const declaredTip = message.frontier.get(message.endpointId);
      if (actualTip !== declaredTip) {
        fail({ code: "STALE_ENDPOINT_TIP", endpointId: message.endpointId,
          declaredTip: declaredTip ?? null, actualTip: actualTip ?? null });
      }
      if (actualTip) {
        const previous = await history.get(actualTip);
        if (!previous) badHistory("missing-dependency", "Missing endpoint tip", [actualTip]);
        for (const [endpoint, required] of previous.frontier) {
          if (!await history.ancestor(endpoint, required, message.frontier.get(endpoint))) {
            fail({ code: "OBSERVATION_REGRESSION", endpointId: endpoint, required,
              declared: message.frontier.get(endpoint) ?? null });
          }
        }
      }
      await history.closed(message.frontier, false);
      if (history.boundary === Number.MAX_SAFE_INTEGER) {
        fail({ code: "SEQUENCE_EXHAUSTED", latestSequence: history.boundary });
      }
      const appended = await this.strategy.append({
        expectedSequence: history.boundary, message: copyMessage(message), hash,
      });
      if (!appended.ok) {
        const error = appended.error;
        if (error.code === "SEQUENCE_CONFLICT") {
          if (error.expectedSequence !== history.boundary || !sequence(error.actualSequence)
            || error.actualSequence <= history.boundary) {
            contract("append", "Invalid sequence conflict receipt");
          }
          fail({ code: "CONCURRENT_MODIFICATION", expectedSequence: history.boundary, actualSequence: error.actualSequence });
        }
        if (error.code === "INVALID_APPEND_REQUEST") contract("append", "Rejected a valid storage request");
        if (error.code === "APPEND_OUTCOME_UNKNOWN") {
          fail({ ...error, hash });
        }
        fail(error);
      }
      // A successful append must not introduce another fallible storage read.
      const registered = appended.value;
      const returnedBytes = encodeMessage(registered, this.limits);
      const expectedBytes = encodeMessage(message, this.limits);
      if (!registered || !Number.isSafeInteger(registered.sequence) || registered.sequence <= history.boundary
        || registered.hash !== hash || !returnedBytes.ok || !expectedBytes.ok
        || !sameBytes(returnedBytes.value, expectedBytes.value)) {
        fail({ code: "APPEND_OUTCOME_UNKNOWN", hash, cause: "Strategy returned an invalid append receipt" });
      }
      const currentFrontier = new Map(history.tips);
      currentFrontier.set(message.endpointId, hash);
      return { message: copyRegistered(registered), currentFrontier };
    }, sendError);
  }

  read(request: ReadRequest): ReturnType<Channel["read"]> {
    return capture(async () => {
      if (!request || !Number.isSafeInteger(request.limit) || request.limit <= 0) {
        fail({ code: "INVALID_READ_REQUEST", reason: "limit must be a positive safe integer" });
      }
      if (request.limit > this.limits.maxPageMessages) {
        fail({ code: "LIMIT_EXCEEDED", limit: "maxPageMessages", maximum: this.limits.maxPageMessages, actual: request.limit });
      }
      const limit = request.limit;
      frontierShape(request.after, this.limits);
      const after = new Map(request.after);
      let boundary = await latest(this.strategy);
      const preliminary = new History(this.strategy, this.limits, boundary);
      for (const hash of after.values()) {
        const node = await preliminary.get(hash);
        if (!node) fail({ code: "UNKNOWN_REFERENCE", hash });
        if (node.sequence > boundary) boundary = await latest(this.strategy);
        if (node.sequence > boundary) contract("getLatestSequence", "High-water mark is behind a visible record");
      }
      const history = await view(this.strategy, this.limits, boundary);
      await history.closed(after, false);
      for (const [endpoint, hash] of after) {
        if (!await history.ancestor(endpoint, hash, history.tips.get(endpoint))) {
          contract("get", "Reference is outside registered history");
        }
      }
      const messages = [];
      const nextFrontier = new Map(after);
      let bytes = 0;
      let hasMore = false;
      for await (const message of history.scan()) {
        if (await history.ancestor(message.endpointId, message.hash, after.get(message.endpointId))) continue;
        if (messages.length === limit) { hasMore = true; break; }
        const encoded = encodeMessage(message, this.limits);
        if (!encoded.ok) fail(encoded.error);
        bytes += encoded.value.length;
        if (bytes > this.limits.maxPageBytes) {
          fail({ code: "LIMIT_EXCEEDED", limit: "maxPageBytes", maximum: this.limits.maxPageBytes, actual: bytes });
        }
        messages.push(copyRegistered(message));
        for (const [endpoint, required] of message.frontier) {
          if (!await history.ancestor(endpoint, required, nextFrontier.get(endpoint))) nextFrontier.set(endpoint, required);
        }
        nextFrontier.set(message.endpointId, message.hash);
      }
      return { messages, nextFrontier, hasMore };
    }, readError);
  }

  getState(): ReturnType<Channel["getState"]> {
    return capture(async () => ({ currentFrontier: new Map((await view(this.strategy, this.limits)).tips) }), stateError);
  }

  watch(observer: ChannelObserver): Result<Unwatch, WatchStartError> {
    if (!observer || typeof observer.onChange !== "function" || typeof observer.onError !== "function") {
      return err({ code: "INVALID_OBSERVER" });
    }
    let active = true;
    let running = false;
    let dirty = false;
    let cancel: Unwatch | undefined;
    let cancelled = false;
    const schedule = () => {
      if (!active) return;
      dirty = true;
      if (running) return;
      running = true;
      queueMicrotask(() => {
        void (async () => {
          while (active && dirty) {
            dirty = false;
            const state = await this.getState();
            if (!active) break;
            if (state.ok) observer.onChange(state.value);
            else observer.onError(state.error);
          }
        })().finally(() => { running = false; }).catch(error => {
          queueMicrotask(() => { throw error; });
        });
      });
    };
    const subscribed = this.strategy.watch({
      onChange: schedule,
      onError: error => {
        if (!active) return;
        active = false;
        cancel?.();
        queueMicrotask(() => { if (!cancelled) observer.onError(error); });
      },
    });
    if (!subscribed.ok) { active = false; return subscribed; }
    cancel = subscribed.value;
    if (!active) cancel();
    schedule();
    return ok(() => {
      if (cancelled) return;
      cancelled = true;
      if (!active) return;
      active = false;
      cancel?.();
    });
  }
}

export function createChannel(options: ChannelOptions): Result<Channel, import("./types.js").CreateChannelError> {
  if (!options?.persistence) return err({ code: "INVALID_OPTIONS", field: "persistence", reason: "Missing strategy" });
  const strategy = options.persistence;
  for (const method of ["getLatestSequence", "get", "scan", "append", "watch"] as const) {
    if (typeof strategy[method] !== "function") {
      return err({ code: "INVALID_OPTIONS", field: method, reason: "Missing strategy method" });
    }
  }
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) {
      return err({ code: "INVALID_OPTIONS", field: key, reason: "Unknown resource limit" });
    }
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffff_ffff) {
      return err({ code: "INVALID_OPTIONS", field: key, reason: "Limits must be positive u32 safe integers" });
    }
  }
  return ok(new CausalChannel(strategy, limits));
}
