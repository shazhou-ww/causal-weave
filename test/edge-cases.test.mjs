import test from "node:test";
import assert from "node:assert/strict";
import { createChannel, hashMessage } from "../dist/index.js";
import { A, B, C, fixture, message, unwrap, error, ok, tick } from "./strategy.mjs";

test("same endpoint concurrency produces one registration, then stale tip rather than a fork", async () => {
  const { channel, strategy } = fixture();
  const second = unwrap(createChannel({ persistence: strategy }));
  const original = strategy.append.bind(strategy);
  let release, count = 0;
  const ready = new Promise(resolve => { release = resolve; });
  strategy.append = async request => {
    if (++count === 2) release();
    await ready;
    return original(request);
  };
  const inputs = [message(A, new Map(), "first"), message(A, new Map(), "second")];
  const results = await Promise.all([channel.send(inputs[0]), second.send(inputs[1])]);
  assert.equal(results.filter(value => value.ok).length, 1);
  const index = results[0].ok ? 1 : 0;
  assert.equal(results[index].error.code, "CONCURRENT_MODIFICATION");
  assert.equal((await channel.send(inputs[index])).error.code, "STALE_ENDPOINT_TIP");
  assert.equal((await channel.getState()).ok, true);
  assert.equal(strategy.records.length, 1);
});

test("safe integer sequence exhaustion, holes and immutable high-water rules", async () => {
  const { channel, strategy } = fixture();
  const input = message();
  strategy.records.push({ ...input, hash: unwrap(await hashMessage(input)), sequence: Number.MAX_SAFE_INTEGER });
  assert.equal((await channel.send(message(B))).error.code, "SEQUENCE_EXHAUSTED");
  assert.equal(strategy.appendCalls, 0);
  assert.equal((await channel.send(input)).ok, true);
  assert.equal((await channel.read({ after: new Map(), limit: 1 })).ok, true);
  strategy.getLatestSequence = async () => ok(Number.MAX_SAFE_INTEGER + 1);
  assert.equal((await channel.getState()).error.code, "STRATEGY_CONTRACT");
});

test("history, node-visit and output-byte limits return explicit errors at measurable thresholds", async () => {
  const setup = fixture();
  await setup.channel.send(message());
  const exact = unwrap(createChannel({ persistence: setup.strategy, limits: { maxHistoryNodes: 1 } }));
  assert.equal((await exact.read({ after: new Map(), limit: 1 })).ok, true);
  await setup.channel.send(message(B));
  const nodes = unwrap(createChannel({ persistence: setup.strategy, limits: { maxHistoryNodes: 1 } }));
  assert.equal((await nodes.getState()).error.limit, "maxHistoryNodes");
  const reads = unwrap(createChannel({ persistence: setup.strategy, limits: { maxNodeReads: 1 } }));
  assert.equal((await reads.getState()).error.limit, "maxNodeReads");
  const page = unwrap(createChannel({ persistence: setup.strategy, limits: { maxPageBytes: 1 } }));
  assert.equal((await page.read({ after: new Map(), limit: 1 })).error.limit, "maxPageBytes");
  assert.equal((await setup.channel.read({ after: new Map(), limit: 1 })).ok, true);
});

test("dependency registration must precede its dependent message", async () => {
  const { channel, strategy } = fixture();
  const future = message(A);
  const hash = unwrap(await hashMessage(future));
  const early = message(B, new Map([[A, hash]]));
  strategy.records.push(
    { ...early, hash: unwrap(await hashMessage(early)), sequence: 1 },
    { ...future, hash, sequence: 2 },
  );
  assert.equal((await channel.getState()).error.reason, "registration");
});

test("stored observation regression and closure failure are history errors, not user request errors", async () => {
  for (const mode of ["regression", "closure"]) {
    const { channel, strategy } = fixture();
    const a = unwrap(await channel.send(message())).message;
    const b = unwrap(await channel.send(message(B, new Map([[A, a.hash]])))).message;
    const invalid = mode === "regression"
      ? message(B, new Map([[B, b.hash]]), "invalid")
      : message(C, new Map([[B, b.hash]]), "invalid");
    strategy.records.push({ ...invalid, sequence: 3, hash: unwrap(await hashMessage(invalid)) });
    const result = await channel.getState();
    assert.equal(result.error.code, "INVALID_HISTORY");
    assert.equal(result.error.reason, "causal-declaration");
  }
});

test("strategy rejection of library-generated valid parameters is a contract error", async () => {
  const { channel, strategy } = fixture();
  strategy.append = async () => error("INVALID_APPEND_REQUEST", { reason: "bad integration" });
  assert.equal((await channel.send(message())).error.code, "STRATEGY_CONTRACT");
  strategy.scan = async () => error("INVALID_SCAN_REQUEST", { reason: "bad integration" });
  strategy.getLatestSequence = async () => ok(1);
  assert.equal((await channel.getState()).error.code, "STRATEGY_CONTRACT");
  const invalidConflict = fixture();
  invalidConflict.strategy.append = async () => error("SEQUENCE_CONFLICT", { expectedSequence: 0, actualSequence: 0 });
  assert.equal((await invalidConflict.channel.send(message())).error.code, "STRATEGY_CONTRACT");
});

test("new messages during page scanning are deferred, not permanently hidden by hasMore=false", async () => {
  const { channel, strategy } = fixture();
  const first = unwrap(await channel.send(message())).message;
  const input = message(B);
  const second = { ...input, hash: unwrap(await hashMessage(input)), sequence: 2 };
  const original = strategy.scan.bind(strategy);
  let once = true;
  strategy.scan = async request => {
    if (once) { once = false; strategy.records.push(second); }
    return original(request);
  };
  const page = unwrap(await channel.read({ after: new Map(), limit: 10 }));
  assert.deepEqual(page.messages.map(node => node.hash), [first.hash]);
  assert.equal(page.hasMore, false);
  const next = unwrap(await channel.read({ after: page.nextFrontier, limit: 10 }));
  assert.deepEqual(next.messages.map(node => node.hash), [second.hash]);
});

test("registration before initial state prevents notification gaps", async () => {
  const { channel, strategy } = fixture();
  const input = message();
  const registered = { ...input, hash: unwrap(await hashMessage(input)), sequence: 1 };
  const original = strategy.watch.bind(strategy);
  strategy.watch = observer => {
    const subscription = original(observer);
    strategy.records.push(registered);
    strategy.notify();
    return subscription;
  };
  const states = [];
  const cancel = unwrap(channel.watch({ onChange: state => states.push(state), onError: assert.fail }));
  await tick();
  assert.equal(states.at(-1).currentFrontier.get(A), registered.hash);
  cancel();
});

test("cancel while state calculation is pending suppresses its callback", async () => {
  const { channel, strategy } = fixture();
  let release;
  strategy.getLatestSequence = () => new Promise(resolve => { release = () => resolve(ok(0)); });
  let calls = 0;
  const cancel = unwrap(channel.watch({ onChange() { calls++; }, onError() { calls++; } }));
  await tick();
  cancel(); release(); await tick();
  assert.equal(calls, 0);
});

test("incomplete high-water scan and incorrect get hash are diagnosed, not treated as empty", async () => {
  const { channel, strategy } = fixture();
  strategy.getLatestSequence = async () => ok(1);
  assert.equal((await channel.getState()).error.code, "STRATEGY_CONTRACT");
  const other = fixture();
  const first = unwrap(await other.channel.send(message())).message;
  other.strategy.get = async () => ok(first);
  assert.equal((await other.channel.send(message(B, new Map([[A, "f".repeat(64)]])))).error.code, "STRATEGY_CONTRACT");
});

test("deterministic multi-endpoint model: every frontier page matches exact causal-set difference", async () => {
  const { channel, strategy } = fixture({ scanBatchSize: 3, cacheSize: 2 });
  const endpoints = [A, B, C];
  const local = new Map(endpoints.map(endpoint => [endpoint, new Map()]));
  let current = new Map();
  let seed = 171;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  for (let index = 0; index < 30; index++) {
    const endpoint = endpoints[random() % endpoints.length];
    const frontier = random() % 3 === 0 ? new Map(current) : new Map(local.get(endpoint));
    const receipt = unwrap(await channel.send(message(endpoint, frontier, `event-${index}`)));
    const observed = new Map(frontier); observed.set(endpoint, receipt.message.hash);
    local.set(endpoint, observed);
    current = new Map(receipt.currentFrontier);
  }
  const byHash = new Map(strategy.records.map(record => [record.hash, record]));
  for (const start of [new Map(), ...local.values()]) {
    const covered = new Set();
    const pending = [...start.values()];
    while (pending.length) {
      const hash = pending.pop();
      if (covered.has(hash)) continue;
      covered.add(hash);
      pending.push(...byHash.get(hash).frontier.values());
    }
    const expected = strategy.records.filter(record => !covered.has(record.hash)).map(record => record.hash);
    const actual = [];
    let after = start;
    for (let pageNumber = 0; pageNumber <= strategy.records.length; pageNumber++) {
      const limit = 1 + random() % 5;
      const page = unwrap(await channel.read({ after, limit }));
      assert.ok(page.messages.length <= limit);
      actual.push(...page.messages.map(record => record.hash));
      after = page.nextFrontier;
      if (!page.hasMore) break;
      assert.ok(page.messages.length > 0);
    }
    assert.deepEqual(actual, expected);
    assert.deepEqual(after, current);
  }
});
