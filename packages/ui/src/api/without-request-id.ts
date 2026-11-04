// The broker's reply helper adds the gateway's own `requestId` to every object a route answers (packages/broker/src/aws/json-reply.ts).
// A strict contract does not list it, so a client that reads such an answer with `safeParse` must set it aside first. Everything else is still read exactly:
// an unknown field from a newer server is refused, not guessed.
export function withoutRequestId(value: unknown): unknown {
 if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
 const own = { ...value } as Record<string, unknown>;
 delete own["requestId"];
 return own;
}
/** A reader for `api.get` / `api.send`: the same schema, after the gateway's `requestId` is set aside. */
export function exactAnswer<T>(schema: { parse(value: unknown): T }): { parse(value: unknown): T } {
 return { parse: (value: unknown): T => schema.parse(withoutRequestId(value)) };
}
