import test from "node:test";
import assert from "node:assert/strict";
import { createChannel, hashMessage, parseMessageHash } from "../dist/index.js";
import { A, B, C, fixture, message, unwrap, error, ok, clone, tick } from "./strategy.mjs";

test("empty state, dynamic endpoints, stale peer observations and derived committed state", async () => {
  const { channel, strategy } = fixture();
  assert.equal(unwrap(await channel.getState()).currentFrontier.size, 0);
  const a1 = unwrap(await channel.send(message())).message;
  const b1 = unwrap(await channel.send(message(B))).message;
  const a2 = unwrap(await channel.send(message(A, new Map([[A, a1.hash]]), "a2"))).message;
  const a3 = unwrap(await channel.send(message(A, new Map([[A, a2.hash], [B, b1.hash]]), "a3"))).message;
  assert.equal(a3.sequence, 4);
  assert.equal("causalFrontier" in a3, false);
  assert.equal(a3.frontier.get(A), a2.hash);
  assert.equal(unwrap(await channel.getState()).currentFrontier.get(A), a3.hash);
  assert.equal(strategy.appendCalls, 4);
});

test("closed frontier, unknown and wrong-endpoint references, stale tip and observation regression", async () => {
  const { channel } = fixture();
  const a1 = unwrap(await channel.send(message())).message;
  const b1 = unwrap(await channel.send(message(B, new Map([[A, a1.hash]])))).message;
  assert.equal((await channel.send(message(C, new Map([[B, b1.hash]])))).error.code, "FRONTIER_NOT_CLOSED");
  assert.equal((await channel.send(message(C, new Map([[B, a1.hash]])))).error.code, "REFERENCE_ENDPOINT_MISMATCH");
  const missing = unwrap(parseMessageHash("f".repeat(64)));
  assert.equal((await channel.send(message(C, new Map([[A, missing]])))).error.code, "UNKNOWN_REFERENCE");
  assert.equal((await channel.send(message(A, new Map(), "different"))).error.code, "STALE_ENDPOINT_TIP");
  assert.equal((await channel.send(message(B, new Map([[B, b1.hash]]), "regression"))).error.code, "OBSERVATION_REGRESSION");
  assert.equal((await channel.read({ after: new Map([[B, b1.hash]]), limit: 1 })).error.code, "FRONTIER_NOT_CLOSED");
});

test("transitive coverage permits a later version rather than exact referenced tip", async () => {
  const { channel } = fixture();
  const a1 = unwrap(await channel.send(message())).message;
  const a2 = unwrap(await channel.send(message(A, new Map([[A, a1.hash]]), "a2"))).message;
  const b = unwrap(await channel.send(message(B, new Map([[A, a1.hash]])))).message;
  assert.equal((await channel.send(message(C, new Map([[A, a2.hash], [B, b.hash]])))).ok, true);
});

test("exact replay preserves sequence even after descendants and does not append", async () => {
  const { channel, strategy } = fixture();
  const input = message();
  const first = unwrap(await channel.send(input));
  const second = unwrap(await channel.send(message(A, new Map([[A, first.message.hash]]), "next")));
  const replay = unwrap(await channel.send(input));
  assert.equal(replay.message.sequence, first.message.sequence);
  assert.equal(replay.currentFrontier.get(A), second.message.hash);
  assert.equal(strategy.appendCalls, 2);
});

test("two instances compete through sequence CAS without hidden retries or fork", async () => {
  const { channel, strategy } = fixture();
  const other = unwrap(createChannel({ persistence: strategy }));
  const append = strategy.append.bind(strategy);
  let release;
  const bothReady = new Promise(resolve => { release = resolve; });
  let arrivals = 0;
  strategy.append = async request => {
    if (++arrivals === 2) release();
    await bothReady;
    return append(request);
  };
  const results = await Promise.all([channel.send(message(A)), other.send(message(B))]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.find(result => !result.ok).error.code, "CONCURRENT_MODIFICATION");
  assert.equal(strategy.records.length, 1);
  assert.equal(strategy.appendCalls, 2);
  const loser = results[0].ok ? B : A;
  assert.equal((await other.send(message(loser))).ok, true);
});

test("successful append never reads storage again to make its receipt", async () => {
  const { channel, strategy } = fixture();
  strategy.beforeAppend = () => { strategy.readError = error("STORAGE_READ", { operation: "all", cause: "offline after append" }); };
  const receipt = unwrap(await channel.send(message()));
  assert.equal(receipt.message.sequence, 1);
  assert.equal(receipt.currentFrontier.get(A), receipt.message.hash);
  assert.equal(strategy.latestCalls, 1);
});

test("unknown write result remains unknown; exact retry confirms original registration", async () => {
  const { channel, strategy } = fixture();
  strategy.unknownAfterWrite = true;
  const input = message();
  const result = await channel.send(input);
  assert.equal(result.error.code, "APPEND_OUTCOME_UNKNOWN");
  assert.equal(strategy.records.length, 1);
  const confirmed = unwrap(await channel.send(input));
  assert.equal(confirmed.message.sequence, 1);
  assert.equal(strategy.appendCalls, 1);
});

test("definite write failure and read errors are never success-shaped fallbacks", async () => {
  const { channel, strategy } = fixture();
  strategy.appendFailure = error("STORAGE_WRITE", { cause: "rollback" });
  assert.equal((await channel.send(message())).error.code, "STORAGE_WRITE");
  assert.equal(strategy.records.length, 0);
  strategy.readError = error("STORAGE_READ", { operation: "latest", cause: "offline" });
  assert.equal((await channel.getState()).error.code, "STORAGE_READ");
  assert.equal((await channel.read({ after: new Map(), limit: 1 })).error.code, "STORAGE_READ");
});

test("frontier pagination accumulates progress, includes all endpoints and tolerates between-page append", async () => {
  const { channel } = fixture({ scanBatchSize: 1, cacheSize: 1 });
  const a = unwrap(await channel.send(message())).message;
  const b = unwrap(await channel.send(message(B))).message;
  const first = unwrap(await channel.read({ after: new Map(), limit: 1 }));
  assert.equal(first.messages[0].hash, a.hash);
  assert.equal(first.hasMore, true);
  const c = unwrap(await channel.send(message(C))).message;
  const second = unwrap(await channel.read({ after: first.nextFrontier, limit: 1 }));
  assert.equal(second.messages[0].hash, b.hash);
  assert.equal(second.nextFrontier.get(A), a.hash);
  assert.equal(second.nextFrontier.get(B), b.hash);
  const third = unwrap(await channel.read({ after: second.nextFrontier, limit: 1 }));
  assert.equal(third.messages[0].hash, c.hash);
  assert.equal(third.hasMore, false);
  const empty = unwrap(await channel.read({ after: third.nextFrontier, limit: 1 }));
  assert.deepEqual(empty.messages, []);
  assert.deepEqual(empty.nextFrontier, third.nextFrontier);
});

test("a non-prefix after frontier does not skip earlier unobserved messages", async () => {
  const { channel } = fixture({ scanBatchSize: 1 });
  const a = unwrap(await channel.send(message())).message;
  const b = unwrap(await channel.send(message(B))).message;
  const page = unwrap(await channel.read({ after: new Map([[B, b.hash]]), limit: 1 }));
  assert.equal(page.messages[0].hash, a.hash);
  assert.equal(page.nextFrontier.get(B), b.hash);
  assert.equal(page.hasMore, false);
});

test("read does not expose session-boundary errors when an after reference appears during the call", async () => {
  const { channel, strategy } = fixture();
  const registered = unwrap(await channel.send(message())).message;
  let calls = 0;
  strategy.getLatestSequence = async () => ok(++calls === 1 ? 0 : 1);
  const result = await channel.read({ after: new Map([[A, registered.hash]]), limit: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.messages, []);
});

test("input and returned buffers and maps do not alter registered facts", async () => {
  const { channel, strategy } = fixture();
  const input = message();
  const pending = channel.send(input);
  input.content[0] = 0; input.frontier.set(B, "f".repeat(64));
  const receipt = unwrap(await pending);
  assert.equal(new TextDecoder().decode(receipt.message.content), "hello");
  receipt.message.content[0] = 0;
  receipt.message.frontier.set(B, "f".repeat(64));
  receipt.currentFrontier.clear();
  const page = unwrap(await channel.read({ after: new Map(), limit: 1 }));
  assert.equal(new TextDecoder().decode(page.messages[0].content), "hello");
  assert.equal(strategy.records[0].frontier.size, 0);
});

test("configuration, read and content validation respect exact resource thresholds", async () => {
  const { strategy } = fixture();
  assert.equal(createChannel({ persistence: strategy, limits: { cacheSize: 0 } }).error.code, "INVALID_OPTIONS");
  const channel = unwrap(createChannel({ persistence: strategy, limits: { maxContentBytes: 5, maxPageMessages: 1, maxIdBytes: 1 } }));
  assert.equal((await channel.send(message())).ok, true);
  assert.equal((await channel.send(message(B, new Map(), "123456"))).error.code, "LIMIT_EXCEEDED");
  assert.equal((await channel.read({ after: new Map(), limit: 2 })).error.code, "LIMIT_EXCEEDED");
  assert.equal((await channel.read({ after: new Map(), limit: 0 })).error.code, "INVALID_READ_REQUEST");
  assert.equal((await channel.read({ after: new Map(), limit: 1 })).ok, true);
});

test("history corruption, missing dependency and endpoint fork are explicit", async () => {
  for (const mode of ["hash", "missing", "fork"]) {
    const { channel, strategy } = fixture();
    const first = unwrap(await channel.send(message())).message;
    if (mode === "hash") strategy.records[0].content[0] = 0;
    else {
      const input = mode === "fork" ? message(A, new Map(), "fork")
        : message(B, new Map([[C, "f".repeat(64)]]), "missing");
      strategy.records.push({ ...input, hash: unwrap(await hashMessage(input)), sequence: 2 });
    }
    const result = await channel.getState();
    assert.equal(result.error.code, "INVALID_HISTORY");
    assert.equal(result.error.reason, mode === "hash" ? "hash-mismatch" : mode === "fork" ? "fork" : "missing-dependency");
    assert.ok(first.hash);
  }
});

test("strategy contract violations, malicious append receipt, and program defects are not hidden", async () => {
  const { channel, strategy } = fixture();
  const first = unwrap(await channel.send(message())).message;
  strategy.scan = async () => ok([clone(first), clone(first)]);
  assert.equal((await channel.getState()).error.code, "STRATEGY_CONTRACT");
  const next = fixture();
  next.strategy.append = async () => ok({ ...message(), hash: "0".repeat(64), sequence: 1 });
  assert.equal((await next.channel.send(message())).error.code, "APPEND_OUTCOME_UNKNOWN");
  const broken = fixture();
  broken.strategy.getLatestSequence = async () => { throw new Error("program defect"); };
  await assert.rejects(broken.channel.getState(), /program defect/);
});

test("watch reports initial state, coalesces, recovers state errors, and cancels idempotently", async () => {
  const { channel, strategy } = fixture();
  const states = [], errors = [];
  const cancel = unwrap(channel.watch({ onChange: state => states.push(state), onError: value => errors.push(value) }));
  await tick();
  assert.equal(states.length, 1);
  strategy.notify(); strategy.notify();
  await tick();
  assert.equal(states.length, 2);
  strategy.readError = error("STORAGE_READ", { operation: "latest", cause: "temporary" });
  strategy.notify(); await tick();
  assert.equal(errors[0].code, "STORAGE_READ");
  strategy.readError = undefined;
  await channel.send(message()); await tick();
  assert.equal(states.at(-1).currentFrontier.size, 1);
  cancel(); cancel(); strategy.notify(); await tick();
  assert.equal(strategy.stopCalls, 1);
  assert.equal(strategy.observers.size, 0);
});

test("watch start failure, immediate cancellation and terminal notification error", async () => {
  const { channel, strategy } = fixture();
  assert.equal(channel.watch({}).error.code, "INVALID_OBSERVER");
  strategy.watchError = error("SUBSCRIPTION_START", { cause: "offline" });
  assert.equal(channel.watch({ onChange() {}, onError() {} }).error.code, "SUBSCRIPTION_START");
  strategy.watchError = undefined;
  let callbacks = 0;
  unwrap(channel.watch({ onChange() { callbacks++; }, onError() { callbacks++; } }))();
  await tick(); assert.equal(callbacks, 0);
  const errors = [];
  const cancel = unwrap(channel.watch({ onChange() {}, onError: value => errors.push(value) }));
  await tick();
  strategy.failWatch(); await tick();
  assert.equal(errors[0].code, "SUBSCRIPTION");
  assert.equal(strategy.observers.size, 0);
  cancel(); cancel();
});
