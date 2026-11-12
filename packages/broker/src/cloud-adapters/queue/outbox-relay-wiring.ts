// Convergence A2 (no traffic): where Cloud plugs Code's outbox relay into its own triggers. Code's SQS queue adapter and the two generic
// triggers (the stream hook and the scheduled backstop) are written once, in public Rovara Code (`@rovara/aws-adapters/sqs`), over the
// ports only. This file is the Cloud side and holds no copy of them:
//  - the companies the backstop serves (an install has one org, ruling R3);
//  - the off switch: nothing relays until a composition root installs a backstop, and the schedule that calls it is DISABLED in the stack;
//  - the answer for the schedule's event, and the refusal of a stream record Cloud's current publisher already handles.
// The composition root (S0) builds the adapter, the generic triggers and the outbox over Cloud's DynamoDB store and calls `installOutboxRelayBackstop`.
import { installOrgIdFromEnvironment } from "../../org/resolve.js";

/** The report of one scheduled run (Code's `OutboxBackstopReport`; kept structural so this file needs no import of the public package until the pin carries it). */
export interface OutboxRelayBackstopReport {
  delivered: number;
  failed: number;
  dead: number;
  companies: number;
  deferred: number;
  errors: number;
}

export type OutboxRelayBackstop = () => Promise<OutboxRelayBackstopReport>;

let installed: OutboxRelayBackstop | undefined;

/** Called by the composition root once the relay is built in. Replaces any earlier one. */
export function installOutboxRelayBackstop(backstop: OutboxRelayBackstop | undefined): void {
  installed = backstop;
}

export function isOutboxRelayBackstopEvent(event: unknown): event is { source: "agentx.outbox-relay-backstop" } {
  return event !== null && typeof event === "object" && (event as { source?: unknown }).source === "agentx.outbox-relay-backstop";
}

/** The companies the backstop relays for: the install's one org. */
export function outboxRelayCompanies(env: NodeJS.ProcessEnv = process.env): () => Promise<readonly string[]> {
  return async () => [installOrgIdFromEnvironment(env)];
}

/** One scheduled run. With no relay installed it does nothing and says so; a failure is logged by name only and never thrown to the schedule. */
export async function runOutboxRelayBackstop(): Promise<OutboxRelayBackstopReport | { skipped: "not_wired" } | { error: "relay_failed" }> {
  const backstop = installed;
  if (backstop === undefined) return { skipped: "not_wired" };
  try {
    return await backstop();
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "outbox_relay.backstop_failed", error: error instanceof Error ? error.name : "unknown" }));
    return { error: "relay_failed" };
  }
}
