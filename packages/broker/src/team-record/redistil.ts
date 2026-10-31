// The ONE re-distil path (design 4.4.3, W-8). When some of a fact's sources are deleted, the record core's purge asks this port for a new note made from the sources that
// are left. It reads each remaining source's text from the hot table (a row still holding live, unexpired text), builds the storage lane's `DistillItem`s, lets the
// storage lane's `decideRedistill` say what to do (keep, delete, or re-make) and `distillBundle` write the note. A source whose text cannot be read again (retention A or B,
// or C past 30 days, or a row already gone) counts as unreadable: with no readable source the fact is deleted. The purge keeps the old fact's trust and audience
// (the more conservative reading), so this port returns text and links only.
import { distillBundle, type DistillDeps, type DistillItem, type SourceState } from "./distill.js";
import { derivedItemId } from "./transient-distiller.js";
import { splitQuotedSpans } from "./quotes.js";
import { bySource, eventFromItem } from "./store.js";
import type { RedistilPort } from "./purge.js";
import type { TeamRecordTable } from "./types.js";

export function createRedistilPort(deps: { table: TeamRecordTable; distill: DistillDeps; now?: () => number }): RedistilPort {
  return {
    async redistil(input) {
      const nowSeconds = Math.floor((deps.now ?? Date.now)() / 1000);
      const states: SourceState[] = [];
      for (const ref of input.remaining) {
        const id = derivedItemId(ref.system, ref.sourceId);
        const found = await bySource(deps.table, input.orgId, ref.system, ref.sourceId, 20);
        const event = found.items.map((item) => eventFromItem(item, nowSeconds)).find((candidate) => candidate !== undefined && candidate.tombstone === undefined && candidate.text !== undefined);
        if (event?.text === undefined) { states.push({ id, state: "live_no_text" }); continue; }
        const item: DistillItem = { id, trust: event.trust, audience: event.audience, links: event.links, spans: splitQuotedSpans({ text: event.text, trust: event.trust }) };
        states.push({ id, state: "live_text", item });
      }
      // The deleted sources are not in `remaining`, so the question is only: is any remaining source still readable? With none, the fact is deleted (privacy wins).
      // (Storage's `decideRedistill` is the same rule over the full source list, including the deleted ones; here the purge has already settled which are gone.)
      const readable = states.flatMap((state) => (state.state === "live_text" ? [state.item] : []));
      if (readable.length === 0) return undefined;
      const outcome = await distillBundle(deps.distill, { workspaceId: input.orgId, ...(input.project === undefined ? {} : { project: input.project }), retention: "C", items: readable });
      const fact = outcome.facts.find((candidate) => candidate.kind === input.kind) ?? outcome.facts[0];
      return fact === undefined ? undefined : { text: fact.text, links: fact.links };
    },
  };
}
