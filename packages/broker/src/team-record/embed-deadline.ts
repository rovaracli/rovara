// L2 (DECISIONS 140): a hard end for the embedding done inside an SQS batch. The Team record's queue consumer (runtime.ts `drain`) works through up to 10 messages in the broker's 30 s. Each message
// that stores a row embeds it, and before this change the ingest embedder waited up to its own limit (15 s) for each one, uncapped by the batch, so a slow or cold embedder could spend 15 s on each of two
// messages and time the whole batch out (every message then redelivered, its receive count raised with no code run). Now the drain wraps each message's work in `runWithEmbedDeadline(end, ...)`, and the
// ingest embedder (wrapped by `withEmbedDeadline`) hands that end to every call as its `deadline`: the embedder client never waits past it, and sends nothing at all when too little is left (the row then keeps
// `embedPending` and the re-embed job finishes it). Code outside a drain (a webhook, a tap) has no deadline in scope and keeps the client's own wait.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Embedder } from "./embed.js";

const scope = new AsyncLocalStorage<{ deadline: number }>();

/** Runs `work` with an absolute end time (the client's clock, milliseconds) for every embedding call made inside it. */
export function runWithEmbedDeadline<T>(deadline: number, work: () => Promise<T>): Promise<T> {
  return scope.run({ deadline }, work);
}

/** The deadline in scope, if any. */
export function embedDeadlineInScope(): number | undefined {
  return scope.getStore()?.deadline;
}

function merged(call: { deadline?: number } | undefined): { deadline?: number } | undefined {
  const inScope = embedDeadlineInScope();
  if (inScope === undefined) return call;
  return { ...call, deadline: call?.deadline === undefined ? inScope : Math.min(call.deadline, inScope) };
}

/** The same embedder, every call capped by the deadline in scope (the earlier of that and the call's own). */
export function withEmbedDeadline(embedder: Embedder): Embedder {
  return {
    ...embedder,
    embedWithInfo: (text, purpose, call) => embedder.embedWithInfo(text, purpose, merged(call)),
    embedManyWithInfo: (texts, purpose, call) => embedder.embedManyWithInfo(texts, purpose, merged(call)),
    embed: async (text, purpose) => (await embedder.embedWithInfo(text, purpose, merged(undefined))).vector,
  };
}
