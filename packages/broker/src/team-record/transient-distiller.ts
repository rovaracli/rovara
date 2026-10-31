// Glue between the ingest queue's retention-B messages and the storage lane's distiller (design 4.4, W-1/W-7):
//   admit  -> the draft passes EVERYTHING a stored row passes (`admitTransient`: mode, source row and opt-in, exclusion list, erased-person check, deleted-at-source
//             marker, trust, hygiene). A refusal drops the text. An unreadable marker THROWS so the queue redelivers (and drops after three tries, as the transient queue does).
//   split  -> the storage lane's quote splitter makes the spans (a quoted or forwarded piece keeps its own author's trust, unknown is outsider);
//   distil -> `distillBundle` (no tools; outsider spans never reach the model);
//   write  -> each fact is stored with the places it came from, and each source item it came from gets a derivation link carrying the ACTOR and the PLACE, with the item id
//             in the form `system:sourceId`, so a delete at the source, a deleted place, or an erase of the person finds the fact later with no row left.
// The model call and its spend are the caller's (`DistillDeps.model`). Nothing here logs text or a model error.
import type { TransientDistillerPort } from "./sources/ports.js";
import { distillBundle, type DistillDeps, type DistillItem } from "./distill.js";
import { admitTransient, type IngestDependencies } from "./ingest.js";
import { splitQuotedSpans } from "./quotes.js";
import { trustRank } from "./taint.js";
import type { TrustClass } from "./shared-types.js";
import { supersedeItem } from "./scope-work.js";
import { putDerivationLinks, putRecordFact } from "./store.js";

export interface TransientDistillerDependencies {
  ingest: IngestDependencies;
  distill: DistillDeps;
  /** Vectors for the notes (a failure leaves the note without one; it is still found by keyword). */
  embedFact?: (fact: { id: string; text: string; project: string | undefined; scope: string; trust: string; audienceKind: "project" | "restricted" }) => Promise<void>;
}

/** The item id a fact's `derivedFrom` and a derivation link use: `system:sourceId`. */
export const derivedItemId = (system: string, sourceId: string): string => `${system}:${sourceId}`;

export function createTransientDistiller(deps: TransientDistillerDependencies): TransientDistillerPort {
  return {
    async distillTransient(draft) {
      // Throws when the erased-person marker cannot be read: the queue then redelivers.
      const admitted = await admitTransient(deps.ingest, draft);
      if (!admitted.admitted) return { accepted: false };
      const { item } = admitted;
      // A newer version of an item replaces the older one: the notes made from the older words are hidden at once and removed by the delete worker.
      if (item.supersedes !== undefined) {
        await supersedeItem({ table: deps.ingest.table, ...(deps.ingest.now === undefined ? {} : { now: deps.ingest.now }) }, item.orgId, { system: draft.sourceRef.system, sourceId: draft.sourceRef.id, version: item.supersedes.version, rows: item.supersedes.rows });
      }
      const itemId = derivedItemId(draft.sourceRef.system, draft.sourceRef.id);
      const found = splitQuotedSpans({ text: item.text, trust: item.baseTrust, ...(draft.hasAttachments === true ? { attachments: [{ text: "(attachment)" }] } : {}) });
      // The core's reading of the row (its quote and forward check, the tap's piece trusts, the item's history) can be lower than the splitter's: its detectors are broader (a
      // "Fwd:" on a later line, "forwarded from" mid-line). When it is lower than every span, it is the ceiling for all of them, so what the core calls someone else's words
      // never reaches the model as the member's own. A message the splitter already split (a quote, an attachment) keeps its own words, as they are separate spans.
      const lowestSpan = found.reduce<TrustClass>((lowest, span) => (trustRank(span.trust) < trustRank(lowest) ? span.trust : lowest), item.baseTrust);
      const spans = trustRank(item.trust) < trustRank(lowestSpan) ? found.map((span) => ({ ...span, trust: item.trust })) : found;
      const distillItem: DistillItem = { id: itemId, trust: item.baseTrust, audience: item.audience, links: item.links, spans };
      const outcome = await distillBundle(deps.distill, { workspaceId: item.orgId, ...(item.project === undefined ? {} : { project: item.project }), retention: "B", items: [distillItem] });
      if (outcome.facts.length === 0) return { accepted: outcome.failed === undefined || outcome.failed === "no_input" };
      for (const fact of outcome.facts) {
        // The fact is hidden by its place and by its source item while any delete or permission change on them is pending.
        await putRecordFact(deps.ingest.table, fact, [item.scope]);
        await putDerivationLinks(deps.ingest.table, {
          orgId: item.orgId, project: item.project, factId: fact.id, at: deps.distill.now(),
          sources: [{ system: draft.sourceRef.system, sourceId: draft.sourceRef.id, scope: item.scope, ...(draft.actor === undefined ? {} : { actor: { sourceId: draft.actor.sourceId, ...(draft.actor.developerId === undefined ? {} : { developerId: draft.actor.developerId }) } }) }],
        });
        if (deps.embedFact !== undefined) {
          await deps.embedFact({ id: fact.id, text: fact.text, project: item.project, scope: item.scope, trust: fact.trust, audienceKind: fact.audience.kind }).catch(() => undefined);
        }
      }
      return { accepted: true };
    },
  };
}
