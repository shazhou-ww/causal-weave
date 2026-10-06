import { createChannel, parseEndpointId } from "../dist/index.js";

export const ok = value => ({ ok: true, value });
export const error = (code, details = {}) => ({ ok: false, error: { code, ...details } });
export const unwrap = result => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};
export const id = value => unwrap(parseEndpointId(value));
export const A = id("A");
export const B = id("B");
export const C = id("C");
export const clone = message => ({
  ...message, frontier: new Map(message.frontier), content: new Uint8Array(message.content),
});
export const message = (endpointId = A, frontier = new Map(), text = "hello") => ({
  endpointId, frontier, contentType: "text/plain", content: new TextEncoder().encode(text),
});
export const tick = () => new Promise(resolve => setTimeout(resolve, 0));

export class MemoryStrategy {
  records = [];
  observers = new Set();
  appendCalls = 0;
  latestCalls = 0;
  scanCalls = [];
  readError;
  appendFailure;
  unknownAfterWrite = false;
  beforeAppend;
  watchError;
  stopCalls = 0;
  async getLatestSequence() {
    this.latestCalls++;
    return this.readError ?? ok(this.records.at(-1)?.sequence ?? 0);
  }
  async get(hash) {
    if (this.readError) return this.readError;
    const found = this.records.find(record => record.hash === hash);
    return ok(found ? clone(found) : undefined);
  }
  async scan(request) {
    this.scanCalls.push({ ...request });
    if (this.readError) return this.readError;
    return ok(this.records.filter(record =>
      record.sequence > request.afterSequence && record.sequence <= request.throughSequence)
      .slice(0, request.limit).map(clone));
  }
  async append(request) {
    this.appendCalls++;
    this.beforeAppend?.(request);
    if (this.appendFailure) return this.appendFailure;
    const actual = this.records.at(-1)?.sequence ?? 0;
    if (actual !== request.expectedSequence) {
      return error("SEQUENCE_CONFLICT", { expectedSequence: request.expectedSequence, actualSequence: actual });
    }
    const record = { ...clone(request.message), hash: request.hash, sequence: actual + 1 };
    this.records.push(record);
    this.notify();
    if (this.unknownAfterWrite) return error("APPEND_OUTCOME_UNKNOWN", { hash: request.hash, cause: "response lost" });
    return ok(clone(record));
  }
  watch(observer) {
    if (this.watchError) return this.watchError;
    this.observers.add(observer);
    return ok(() => { this.stopCalls++; this.observers.delete(observer); });
  }
  notify() {
    for (const observer of this.observers) observer.onChange();
  }
  failWatch() {
    for (const observer of [...this.observers]) observer.onError({ code: "SUBSCRIPTION", cause: "closed" });
  }
}
export function fixture(limits) {
  const strategy = new MemoryStrategy();
  const channel = unwrap(createChannel({ persistence: strategy, ...(limits ? { limits } : {}) }));
  return { strategy, channel };
}
