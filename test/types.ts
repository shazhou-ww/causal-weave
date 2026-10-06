import {
  createChannel, parseEndpointId, createFrontier, type Channel,
  type PersistenceStrategy, type Message, type RegisteredMessage, type SendError,
} from "../src/index.js";

declare const strategy: PersistenceStrategy;
const created = createChannel({ persistence: strategy });
if (created.ok) {
  const channel: Channel = created.value;
  const endpoint = parseEndpointId("A");
  const frontier = createFrontier();
  if (endpoint.ok && frontier.ok) {
    const message: Message = {
      endpointId: endpoint.value, frontier: frontier.value,
      contentType: "custom", content: new Uint8Array(),
    };
    void channel.send(message).then(result => {
      if (result.ok) {
        const registered: RegisteredMessage = result.value.message;
        // @ts-expect-error Derived causal frontier is not a public message field.
        registered.causalFrontier;
      } else {
        const error: SendError = result.error;
        if (error.code === "CONCURRENT_MODIFICATION") error.actualSequence;
        // @ts-expect-error A read-session boundary is not a public error.
        if (error.code === "FRONTIER_BEYOND_BOUNDARY") throw error;
      }
    });
    // @ts-expect-error contentType is part of the common message contract.
    void channel.send({ endpointId: endpoint.value, frontier: frontier.value, content: new Uint8Array() });
    // @ts-expect-error Ordinary strings do not bypass endpoint validation.
    void channel.send({ ...message, endpointId: "A" });
  }
}
