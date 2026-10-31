// The inventory of every stored field that can carry a person's id (fix round 11). Erasure does not rely on code paths that happen to know where an id can live: it walks THIS list,
// by step, and `tests/unit/team-record-core/person-fields.test.ts` fails when a schema gains a field that looks like a person id and is not named here. Adding a field means
// choosing how it is erased (a step), or saying why it holds no person.
import type { AclSnapshot } from "@agentx/contracts";

/** The erase steps. Each runs on its own, is reported in `EraseResult.steps`, and is resumed by the next run when it did not finish. */
export const ERASE_STEPS = ["lake", "principals", "access", "config", "lessons", "rows"] as const;
export type EraseStep = (typeof ERASE_STEPS)[number];

export interface PersonField {
  /** Where the field lives. */
  store: "hot" | "lake" | "lessons";
  /** The field, as a path in its item. */
  path: string;
  /** The schema field names this entry covers (what the guard test looks for). */
  names: readonly string[];
  /** The step that removes the id from it, or `never_stored` when the writer drops it before it reaches storage (and the writer is tested). */
  step: EraseStep | "never_stored";
  note: string;
}

export const PERSON_FIELDS: readonly PersonField[] = [
  { store: "hot", path: "event.actor.sourceId / developerId", names: ["actor", "sourceId", "developerId", "actorSourceHash"], step: "rows", note: "rows made by the person are found by the actor indexes, hidden, then deleted with their vectors and facts" },
  { store: "hot", path: "event.audience.acl.principals; fact.audience.acl.principals", names: ["principals"], step: "principals", note: "the id leaves the row snapshot of every place the person is in (places come from the unit headers, the person index, their own rows and the explicit list)" },
  { store: "hot", path: "event.structured.updatedBy / revertedBy", names: ["updatedBy", "revertedBy", "updaterId"], step: "never_stored", note: "actor ids in structured fields are dropped at ingest (ACTOR_STRUCTURED_FIELDS), so no row carries them (`revertedBy` on code-host rows is a commit id, dropped too: nothing reads it)" },
  { store: "hot", path: "ACCESS# entries, ACCESSP# index items, headers", names: ["members", "memberIds", "access"], step: "access", note: "each unit the person is in: its place is cleaned, then the entry and the index item go; the erased marker stops any re-add" },
  { store: "hot", path: "source config exclude[], addedBy, approval.by", names: ["exclude", "addedBy", "approval"], step: "config", note: "the exclusion lists that named the person; the developer who added a source or approved a less-safe change becomes the 64-zero stand-in" },
  { store: "hot", path: "LESSONSET#SETTINGS / LESSONSET#COMPANY updatedBy; LESSONSET#TIER0CHG# proposedBy", names: ["proposedBy"], step: "config", note: "the learning lane's tier-0 setting rows; the person becomes the 64-zero stand-in (`scrubTier0Developer`), the value stays" },
  { store: "hot", path: "DELQ# work items add[] / remove[]", names: ["add", "remove"], step: "never_stored", note: "queue items hold ids only until the delete worker finishes them and removes the item" },
  { store: "hot", path: "ERASED# markers (developer id, source ids), ACCESS erased markers", names: ["erased"], step: "never_stored", note: "a suppression marker is kept for good so the person is not re-added; every key is a hash (`recordDeveloperHash`, `recordActorSourceHash`), never the id" },
  { store: "hot", path: "ERASESWEEP# second-pass item (who is being erased)", names: ["sweep"], step: "never_stored", note: "holds the ids only until the erase's delayed second pass reports complete, then is deleted (`runErasureSweeps`)" },
  { store: "hot", path: "event.text / fact.text mentions of a person (<@U..>, [~accountid:..])", names: ["text"], step: "never_stored", note: "mentions of a person by id or name are rewritten to @member at ingest (`scrubPersonalDetails`), so other people's words keep no id; the lake text is written from the hot text" },
  { store: "lake", path: "events/facts acl_json.principals, structured_json, actor_developer_id, actor_source_hash", names: ["acl_json", "structured_json", "actor_developer_id", "actor_source_hash"], step: "lake", note: "acl_json is written without principals and structured_json without actor fields (nothing reads either per viewer); actor_developer_id holds a HASH of the developer id and the lake-delete target carries the same hash; actor_source_hash is a hash too" },
  { store: "lessons", path: "provenance.authors, sources/inputSources member:<id>, approvals[].by, promotionApprovals[].by", names: ["authors", "by", "approvals", "approverId", "promotionApprovals", "createdBy"], step: "lessons", note: "the learning lane's erasePerson hard-deletes lessons resting on the person and scrubs the rest" },
  { store: "lessons", path: "provenance.audience.acl.principals", names: ["audience"], step: "lessons", note: "scrubAudienceIds over every version of every lesson" },
  { store: "lessons", path: "feedback once-keys (Helpful / Wrong here)", names: ["feedback", "markedBy", "once"], step: "never_stored", note: "the key holds only a hash of workspace and user, never the id; it goes with the lesson when the lesson is purged. Marking needs access (recordFeedback)" },
  { store: "lessons", path: "weekly digest, panel rows", names: ["digest", "panel"], step: "never_stored", note: "computed when read; nothing is stored" },
];

/** Structured fields that hold a person's id; ingest drops them so no row carries one. */
export const ACTOR_STRUCTURED_FIELDS: readonly string[] = ["updatedBy", "revertedBy", "updaterId", "createdBy", "assignee", "reporter", "mergedBy"];

/** The structured part of a row without any actor field. */
export function withoutActorFields<T extends Record<string, unknown>>(structured: T | undefined): T | undefined {
  if (structured === undefined) return undefined;
  const kept = Object.fromEntries(Object.entries(structured).filter(([key]) => !ACTOR_STRUCTURED_FIELDS.includes(key))) as T;
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/** An access snapshot as the lake keeps it: scope, source, groups and times, never the list of people. */
export function lakeAcl(acl: AclSnapshot): Omit<AclSnapshot, "principals"> {
  const { principals: _principals, ...rest } = acl; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped on purpose
  return rest;
}

/** The steps the registry requires (the erase must run each). */
export const REQUIRED_ERASE_STEPS: readonly EraseStep[] = ERASE_STEPS.filter((step) => PERSON_FIELDS.some((field) => field.step === step));
