import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  encodeMessage, decodeMessage, hashMessage, parseEndpointId, parseMessageHash,
  createFrontier, DEFAULT_LIMITS,
} from "../dist/index.js";
import { A, B, message, unwrap } from "./strategy.mjs";
import { runBrowserSmoke } from "./browser-smoke.mjs";

test("shared browser smoke vector also passes in Node", async () => {
  assert.equal((await runBrowserSmoke()).checks, 8);
});

test("fixed canonical bytes and independently computed SHA-256", async () => {
  const input = message(A, new Map(), "x");
  const bytes = unwrap(encodeMessage(input));
  const hex = "63617573616c2d7765617665000000000141000000000000000a746578742f706c61696e0000000178";
  assert.equal(Buffer.from(bytes).toString("hex"), hex);
  assert.equal(unwrap(await hashMessage(input)), createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex"));
  const decoded = unwrap(decodeMessage(bytes));
  assert.deepEqual(decoded, input);
  assert.deepEqual(unwrap(encodeMessage(decoded)), bytes);
});

test("UTF-8 byte ordering, format sensitivity and channel-independent addresses", async () => {
  const h = unwrap(parseMessageHash("a".repeat(64)));
  const astral = unwrap(parseEndpointId("\u{10000}"));
  const bmp = unwrap(parseEndpointId("\uE000"));
  const first = message(A, new Map([[astral, h], [bmp, h]]));
  const second = message(A, new Map([[bmp, h], [astral, h]]));
  assert.deepEqual(unwrap(encodeMessage(first)), unwrap(encodeMessage(second)));
  assert.deepEqual([...unwrap(decodeMessage(unwrap(encodeMessage(first)))).frontier.keys()], [bmp, astral]);
  assert.notEqual(unwrap(await hashMessage(first)), unwrap(await hashMessage({ ...first, contentType: "custom-format" })));
  assert.equal(unwrap(await hashMessage(first)), unwrap(await hashMessage({ ...first, channelId: "other", sequence: 999 })));
  for (const change of [
    { endpointId: B }, { content: new Uint8Array([1]) }, { frontier: new Map() },
  ]) assert.notEqual(unwrap(await hashMessage(first)), unwrap(await hashMessage({ ...first, ...change })));
});

test("strict text validation, BOM preservation and no normalization", () => {
  for (const value of ["", "\uD800", "\uDC00"]) assert.equal(parseEndpointId(value).ok, false);
  assert.equal(parseEndpointId(" ").ok, true);
  const input = message(unwrap(parseEndpointId("\uFEFFid")));
  assert.deepEqual(unwrap(decodeMessage(unwrap(encodeMessage(input)))), input);
  const h = unwrap(parseMessageHash("0".repeat(64)));
  assert.equal(createFrontier([[A, h], [A, h]]).ok, false);
  assert.equal(createFrontier([null]).error.code, "INVALID_FRONTIER");
  assert.equal(createFrontier(null).error.code, "INVALID_FRONTIER");
  assert.equal(parseMessageHash("A".repeat(64)).ok, false);
  assert.equal(encodeMessage({ ...input, contentType: "" }).ok, false);
  assert.equal(encodeMessage({ ...input, frontier: new Map([[A, null]]) }).ok, false);
});

test("decoder rejects every truncation, trailing bytes, invalid UTF-8 and wrong prefix", () => {
  const bytes = unwrap(encodeMessage(message()));
  for (let length = 0; length < bytes.length; length++) assert.equal(decodeMessage(bytes.slice(0, length)).ok, false);
  assert.equal(decodeMessage(new Uint8Array([...bytes, 0])).ok, false);
  const wrongPrefix = bytes.slice(); wrongPrefix[0] = 0;
  assert.equal(decodeMessage(wrongPrefix).ok, false);
  const wrongUtf8 = bytes.slice(); wrongUtf8[17] = 255;
  assert.equal(decodeMessage(wrongUtf8).ok, false);
  const hugeLength = bytes.slice(); hugeLength.set([255, 255, 255, 255], 13);
  assert.equal(decodeMessage(hugeLength).error.code, "LIMIT_EXCEEDED");
});

test("decoder rejects unsorted / duplicate frontier keys and limits before allocation", () => {
  const h = unwrap(parseMessageHash("1".repeat(64)));
  const bytes = unwrap(encodeMessage(message(A, new Map([[A, h], [B, h]]))));
  const duplicate = bytes.slice();
  // Prefix (13), endpoint field (5), count (4), entry A (37), then entry B.
  duplicate[63] = 65;
  assert.equal(decodeMessage(duplicate).ok, false);
  const reversed = bytes.slice();
  reversed.set(bytes.slice(59, 96), 22); reversed.set(bytes.slice(22, 59), 59);
  assert.equal(decodeMessage(reversed).ok, false);
  assert.equal(encodeMessage(message(), { ...DEFAULT_LIMITS, maxContentBytes: 1 }).error.code, "LIMIT_EXCEEDED");
  assert.equal(decodeMessage(bytes, { ...DEFAULT_LIMITS, maxFrontierEntries: 1 }).error.code, "LIMIT_EXCEEDED");
});
