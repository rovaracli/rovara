// P6: where a delivery from a code host enters the broker, for any host.
//
//  1. The host kind must be one this install registered. An unknown kind is refused with one fixed sentence (the kind is not echoed) before the delivery is read at all; there is no
//     fallback to GitHub or to any other host.
//  2. The host must receive webhooks and offer a normaliser. A host that polls, or sends nothing, is refused here.
//  3. The host's normaliser verifies the delivery (signature, repository) and maps it to neutral events. It throws on a delivery it cannot verify, and nothing is consumed from one.
//  4. Every event must name the host it came through (an adapter cannot speak for another host) and parse as a neutral event.
//  5. Each event is reserved once by (kind, event id) before it is consumed; a repeat is dropped, and an id reused with other content is refused.
import { agentXError, CodeHostEventSchema, PluginKindSchema, type CodeHostEvent, type HostScope, type PluginKind, type RawDelivery } from "@agentx/contracts";
import { NO_HOST_MESSAGE, type CodeHostRouter } from "../registry.js";
import { codeHostEventHash, type EventReservations } from "./reservations.js";

export const NO_EVENTS_MESSAGE = "This code host does not send events to this install.";
export const EVENT_CONFLICT_MESSAGE = "A delivery id was reused with different content.";
/** The most events one delivery may map to (a host's batch). */
export const MAX_EVENTS_PER_DELIVERY = 50;

export interface CodeHostIntakeInput {
  router: Pick<CodeHostRouter, "kinds" | "forKind">;
  /** The kind the delivery arrived for (from the route). */
  kind: string;
  delivery: RawDelivery;
  scope: HostScope;
  reservations: EventReservations;
  /** Consumes one new event. Throws to leave the event unfinished, so a redelivery tries it again. */
  consume(event: CodeHostEvent): Promise<void>;
}

export interface CodeHostIntakeResult {
  host: PluginKind;
  /** Events consumed now. */
  consumed: CodeHostEvent[];
  /** Events dropped because they were consumed before. */
  duplicates: number;
}

/** The registered kind a route names, or a refusal with the fixed sentence. */
export function requireRegisteredKind(router: Pick<CodeHostRouter, "kinds">, kind: string): PluginKind {
  const parsed = PluginKindSchema.safeParse(kind);
  if (!parsed.success || !router.kinds().includes(parsed.data)) throw agentXError("CONFIG_INVALID", NO_HOST_MESSAGE);
  return parsed.data;
}

export async function receiveCodeHostDelivery(input: CodeHostIntakeInput): Promise<CodeHostIntakeResult> {
  const kind = requireRegisteredKind(input.router, input.kind);
  const host = input.router.forKind(kind);
  const events = host.events;
  if (events.mode !== "webhook" || events.normalise === undefined) throw agentXError("CONFIG_INVALID", NO_EVENTS_MESSAGE);
  const mapped = await events.normalise(input.delivery, input.scope);
  if (mapped.length > MAX_EVENTS_PER_DELIVERY) throw agentXError("CONFIG_INVALID", NO_EVENTS_MESSAGE);
  // All events are checked before any is reserved or consumed: a delivery with one bad event consumes none.
  const checked = mapped.map((event) => {
    const parsed = CodeHostEventSchema.safeParse(event);
    if (!parsed.success || parsed.data.host !== kind) throw agentXError("CONFIG_INVALID", "The code host sent an event this install cannot read.");
    return parsed.data;
  });
  const consumed: CodeHostEvent[] = [];
  let duplicates = 0;
  for (const event of checked) {
    const reserved = await input.reservations.reserve(event, codeHostEventHash(event));
    if (reserved === "conflict") throw agentXError("CONFIG_INVALID", EVENT_CONFLICT_MESSAGE);
    if (reserved === "duplicate") { duplicates += 1; continue; }
    await input.consume(event);
    await input.reservations.complete(event);
    consumed.push(event);
  }
  return { host: kind, consumed, duplicates };
}
