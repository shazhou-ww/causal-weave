import { encodeMessage, decodeMessage, hashMessage } from "../dist/index.js";
import { A, B, fixture, message, unwrap, tick } from "./strategy.mjs";

export async function runBrowserSmoke() {
  const check = (condition, description) => { if (!condition) throw new Error(description); };
  const expectedHash = "c4e1049cb85b122f3282c92a1114a41d33e899d580c5543f2bd7720f6590983d";
  check(unwrap(await hashMessage(message(A, new Map(), "x"))) === expectedHash, "SHA-256 vector");
  const encoded = unwrap(encodeMessage(message()));
  check(unwrap(decodeMessage(encoded)).endpointId === A, "strict decode");
  check(!decodeMessage(new Uint8Array([...encoded, 0])).ok, "reject trailing bytes");
  const { channel } = fixture({ scanBatchSize: 1, cacheSize: 1 });
  const first = unwrap(await channel.send(message())).message;
  const second = unwrap(await channel.send(message(B, new Map([[A, first.hash]])))).message;
  const page = unwrap(await channel.read({ after: new Map(), limit: 1 }));
  check(page.messages[0].hash === first.hash && page.hasMore, "first frontier page");
  const next = unwrap(await channel.read({ after: page.nextFrontier, limit: 1 }));
  check(next.messages[0].hash === second.hash && !next.hasMore, "next frontier page");
  check(unwrap(await channel.send(message())).message.sequence === first.sequence, "exact replay");
  let notifications = 0;
  const cancel = unwrap(channel.watch({ onChange() { notifications++; }, onError(error) { throw new Error(error.code); } }));
  await tick(); cancel(); cancel();
  check(notifications === 1, "initial subscription and cancellation");
  return { checks: 8, hash: expectedHash, messages: 2 };
}
