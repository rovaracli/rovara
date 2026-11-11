// Erase (design 4.4.3, task D1): a person, a project (archive) or a whole workspace (org close) leaves the Team record. These are the functions the v1.2 cleanup
// walks call (`learning/cleanup.ts`, which is not on this branch's base: see the lane report, "Wiring pending"). Each is bounded and resumable: a call does what its
// budget allows and says whether it is complete, and the walk calls again until it is. Hot rows, vectors, facts, lessons and the lake queue follow the same
// privacy order as a source delete (`purgeItems`): the lake first, a row only after its vector.
import { markUnstoredChange } from "./prior-edits.js";
import { MERGE_INDEX_SK_PREFIX, PUSH_INDEX_ENTITY, PUSH_INDEX_SK_PREFIX } from "./capture-indexes.js";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { dropScopeClaim, SLACK_ADD_SK_PREFIX, SOURCE_OPTIONS_SK_PREFIX, SOURCE_REQUEST_SK_PREFIX, SOURCE_REVISION_SK_PREFIX, SOURCE_SCOPE_SK_PREFIX } from "./source-store.js";
import { LESSON_SK_PREFIX, teamRecordPk, type OrgId } from "@rovara-code/contracts";
import { RECORD_EVENT_SK_PREFIX, RECORD_FACT_SK_PREFIX, recordActorSourceHash, recordDeveloperHash, agentFavouritesKey } from "@agentx/cloud-contracts";
import type { Item } from "../agents/table-writes.js";
import { auditRecordErased } from "./audit.js";
import { tableLakeDeleteQueue } from "./lake-queue.js";
import { addPurge, emptyPurge, purgeItems, type PurgeDependencies, type PurgeResult } from "./purge.js";
import { markAccessErased, placeOfUnit, removePersonFromUnit, unitsOfPerson } from "./access.js";
import { identitySystem, markPersonErased } from "./erased.js";
import { OPS_FAILURE_SK_PREFIX, recordOpsFailure } from "./ops-failures.js";
import { PERSON_RATE_KINDS, personRatePrefix, pickerPersonHash, slackAddRatePrefix } from "./query.js";
import { changeScopePrincipals } from "./scope-work.js";
import { REQUIRED_ERASE_STEPS, type EraseStep } from "./person-fields.js";
import { eraseAskPerson } from "../agent-sessions/ask-erase.js";
import { eraseDiagnosisPerson } from "../diagnosis/store.js";
import { rememberErasedAliases } from "../agent-sessions/ask-erased-aliases.js";
import { readOwnChosenName } from "../developer/chosen-name.js";
import type { ScopeCursor } from "./store.js";
import { scrubFixtureDevelopers } from "../test-env/fixture-erase.js";
import { scrubConfigDeveloper, scrubTier0Developer, bySource, byActor, byActorSource, deleteItem, listSourceConfigs, queryPrefix, removeFromExclude, tombstoneItem } from "./store.js";

export interface EraseBudget {
  /** The most items one call reads and removes. */
  maxItems: number;
  /** The most milliseconds one call spends on the permission passes over places (default 20 s); the rest is left to the next run. */
  maxMs?: number;
}
export const DEFAULT_ERASE_BUDGET: EraseBudget = { maxItems: 2_000 };

export interface EraseResult extends PurgeResult {
  /** The learned lessons, skills, manifests and settings removed with a project or a workspace. */
  other: number;
  complete: boolean;
  /** For a person: whether each independent step finished (row snapshots, access records, lessons). A step that did not finish is resumed by the next run. */
  steps?: Record<EraseStep, boolean>;
  /** `complete` means every step finished in this pass. It is FINAL only after the delayed second pass (`runErasureSweeps`) has also reported complete. */
  final?: boolean;
  sweepDueAt?: string;
}

const finish = async (deps: PurgeDependencies, orgId: OrgId, cause: "person_erased" | "project_archived" | "org_closed", occurrence: string, result: EraseResult): Promise<void> => {
  if (!result.complete) return;
  await deps.audit?.(auditRecordErased({ orgId, occurrence, at: new Date((deps.now ?? Date.now)()).toISOString(), cause, rows: result.rows, facts: result.facts, lessons: result.lessonsWithdrawn + result.other, vectors: result.vectors })).catch(() => undefined);
};

/** Who is erased: their developer id, and every source identity they have (a Slack user id, a GitHub numeric id) so rows made before they were mapped go too. */
export interface ErasedPerson {
  developerId?: string;
  identities?: ReadonlyArray<{ system: string; sourceId: string }>;
  /** Places the person was a member of (private channels, repositories) beyond those of their own rows: their ids leave those snapshots too. */
  scopes?: readonly string[];
  /** Projects whose source rows may name them in an exclusion list. */
  projects?: readonly string[];
  /**
   * The names the person was known by (display names). Kept for at most 30 days, with their source ids, ONLY as keyed hashes (`PurgeDependencies.askAliasKey`), so that an Ask still being answered does not write
   * them (`ask-erased-aliases.ts`, register LI-2); then deleted. The name they chose themselves is read here too. Not used anywhere else.
   */
  names?: readonly string[];
  /** ERASE-NAME-1: the caller could not read the person's names (the read failed). The `names` step then leaves their names in place, for the retry to hash first. */
  namesUnread?: boolean;
}

/**
 * A person is erased: every row their actions made is hidden and then deleted with its vector, the facts built from those rows are deleted or re-distilled from the
 * sources that are left, the lessons that rested on them are withdrawn (unless a valid code citation alone supports them), and the lake is told to forget them: by
 * developer id, and by each source identity for rows that never had a developer id. `occurrence` makes the audit event unique (the erase request's id).
 */
export async function erasePerson(deps: PurgeDependencies, orgId: OrgId, who: ErasedPerson, occurrence: string, budget: EraseBudget = DEFAULT_ERASE_BUDGET, options: { sweep?: boolean } = {}): Promise<EraseResult> {
  const now = deps.now ?? Date.now;
  const queue = deps.lakeQueue ?? tableLakeDeleteQueue(deps.table, now);
  const identities = (who.identities ?? []).slice(0, 50).map((identity) => ({ ...identity, system: identitySystem(identity.system) }));
  if (who.developerId === undefined && identities.length === 0) throw new Error("erase: name a developer or a source identity");
  // The marker first: from now on no backfill, poller or edit can bring them back. Then the lake: their events and outcomes there are queued before anything hot is touched.
  await markPersonErased(deps.table, orgId, { developerId: who.developerId, identities }, new Date(now()).toISOString());
  await markAccessErased(deps.table, orgId, identities.map((identity) => identity.sourceId), new Date(now()).toISOString());
  await queue.enqueue(orgId, [
    ...(who.developerId === undefined ? [] : [{ kind: "actor" as const, developerId: recordDeveloperHash(who.developerId) }]),
    ...identities.map((identity) => ({ kind: "actor_source" as const, hash: recordActorSourceHash(identity.system, identity.sourceId) })),
  ]);
  const found: { items: Item[]; truncated: boolean } = who.developerId === undefined ? { items: [], truncated: false } : await byActor(deps.table, orgId, who.developerId, budget.maxItems);
  for (const identity of identities) {
    const more = await byActorSource(deps.table, orgId, identity.system, identity.sourceId, budget.maxItems);
    found.items.push(...more.items);
    found.truncated ||= more.truncated;
  }
  const at = new Date(now()).toISOString();
  // The pushes the person made are kept by their developer id for the authorship proof of a human edit (capture-indexes.ts); they go with the person.
  for (const item of found.items.filter((entry) => entry.entityType === PUSH_INDEX_ENTITY)) {
    if (typeof item.pk === "string" && typeof item.sk === "string") await deleteItem(deps.table, { pk: item.pk, sk: item.sk });
  }
  const distinct = (items: Item[]): Item[] => [...new Map(items.map((item) => [`${item.pk as string}|${item.sk as string}`, item])).values()];
  const rows = distinct(found.items.filter((item) => item.entityType === "TEAM_RECORD_EVENT"));
  // The person's links: those the index names directly (the actor is on each link, so this works with no row left: retention B keeps none, and a row's TTL removes it),
  // and those reached through their rows' source items.
  const links: Item[] = found.items.filter((item) => item.entityType === "TEAM_RECORD_DERIVATION");
  for (const row of rows) {
    const source = row.sourceRef as { system?: unknown; id?: unknown; order?: unknown } | undefined;
    // S2: the person's change rows are about to go; the item's text may still hold their words, so the item is marked first (a hash of it and nothing else).
    if (source?.order !== undefined && typeof source.system === "string" && typeof source.id === "string" && typeof row.source === "string") await markUnstoredChange(deps.table, orgId, { source: row.source, system: source.system, id: source.id }, now());
    if (typeof row.pk === "string" && typeof row.sk === "string") await tombstoneItem(deps.table, { pk: row.pk, sk: row.sk }, { at, cause: "person_erased" });
    if (typeof source?.system !== "string" || typeof source.id !== "string") continue;
    const sourceItems = await bySource(deps.table, orgId, source.system, source.id, 500);
    links.push(...sourceItems.items.filter((item) => item.entityType === "TEAM_RECORD_DERIVATION"));
  }
  const allLinks = distinct(links);
  for (const item of allLinks) {
    if (typeof item.pk === "string" && typeof item.sk === "string") await tombstoneItem(deps.table, { pk: item.pk, sk: item.sk }, { at, cause: "person_erased" });
  }
  // Their ids leave EVERYTHING the registry (`PERSON_FIELDS`) names: one handler per step, each run on its own and recorded. One that cannot finish this run never stops the
  // others, and the next run resumes it. The erased markers were written first, so no event, snapshot or join can put an id back while this runs.
  const ids = identities.map((identity) => identity.sourceId);
  const context: EraseContext = { deps, orgId, who, ids, identities, rows, links: allLinks, at, occurrence, budget, queue, lessonsPurged: 0 };
  const done: Record<EraseStep, boolean> = { lake: true, principals: true, access: true, config: true, lessons: true, asks: true, names: true, diagnoses: true, attribution: true, fixtures: true, rows: true };
  for (const step of REQUIRED_ERASE_STEPS) {
    try {
      if (step === "rows") continue; // last: the rows go only after the lessons that rest on them are settled
      done[step] = await STEP_HANDLERS[step](context);
    } catch {
      deps.log?.("record.erase_step_failed", { step });
      done[step] = false;
      if (step === "lessons") context.lessonsFailed = true;
    }
  }
  // The rows and facts go once the lessons that rest on them are settled (a lesson step that failed leaves them hidden, so the next run still knows their ids).
  const purged: PurgeResult = context.lessonsFailed !== true ? await purgeItems(deps, orgId, [...rows, ...allLinks], { lessonsSettled: true }) : { ...emptyPurge(), blocked: rows.length };
  purged.lessonsWithdrawn += context.lessonsPurged;
  done.rows = !found.truncated && purged.blocked === 0;
  const result: EraseResult = { ...purged, other: 0, complete: Object.values(done).every(Boolean), steps: done };
  if (options.sweep !== true) await finish(deps, orgId, "person_erased", occurrence, result);
  // "Complete" is final only after the sweep. A write that read the person's markers just before they were written (an ingest in flight, a join on another instance) can land after
  // the pass above; so the erase schedules its OWN second pass, delayed, which the delete worker runs (`runErasureSweeps`) with no wiring of its own.
  if (result.complete && options.sweep !== true) {
    const sweepKey = { pk: teamRecordPk(orgId), sk: `${ERASE_SWEEP_PREFIX}${occurrence}` };
    let dueAt = now() + ERASE_SWEEP_DELAY_MS;
    // TR-E2a: the first due time stands. Re-running a completed erase finds the item and leaves it (a later pass must not push the second pass out, again and again).
    try {
      await deps.table.documentClient.send(new PutCommand({ TableName: deps.table.tableName, Item: { ...sweepKey, entityType: "TEAM_RECORD_ERASE_SWEEP", occurrence, who: withoutNames(who), dueAt, indexExpiresAt: sweepExpiry(dueAt) }, ConditionExpression: "attribute_not_exists(pk)" }));
    } catch (error) {
      if ((error as { name?: string } | undefined)?.name !== "ConditionalCheckFailedException") throw error;
      const kept = await deps.table.documentClient.send(new GetCommand({ TableName: deps.table.tableName, Key: sweepKey, ConsistentRead: true })) as { Item?: Item };
      if (typeof kept.Item?.dueAt === "number") dueAt = kept.Item.dueAt;
    }
    return { ...result, final: false, sweepDueAt: new Date(dueAt).toISOString() };
  }
  return { ...result, final: options.sweep === true && result.complete };
}

/** The person as the second pass keeps them: ids only. The names (kept 30 days at most, apart, for the Asks) never ride in the sweep item. */
const withoutNames = ({ names: _names, ...rest }: ErasedPerson): ErasedPerson => { void _names; return rest; };

/** How long after a complete erase its second pass runs. */
export const ERASE_SWEEP_DELAY_MS = 15 * 60_000;
const ERASE_SWEEP_PREFIX = "ERASESWEEP#";
/** The sweep item holds ids, so it expires on its own if the sweep never runs: the table's expiry attribute (seconds), a week after the item is due. */
export const ERASE_SWEEP_EXPIRY_MS = 7 * 86_400_000;
const sweepExpiry = (dueAtMs: number): number => Math.floor((dueAtMs + ERASE_SWEEP_EXPIRY_MS) / 1000);

/**
 * The second pass of every erase that reported complete and is due: the same erase, run again (it is idempotent), which removes whatever a late write put back. Once it reports complete
 * the sweep item is deleted and the erase is final; if it finds more work it is kept and tried again later. Called by the delete worker on every run.
 */
export async function runErasureSweeps(deps: PurgeDependencies, orgId: OrgId, nowMs: number): Promise<{ ran: number; final: number }> {
  const found = await queryPrefix(deps.table, orgId, undefined, ERASE_SWEEP_PREFIX, 50);
  let ran = 0;
  let final = 0;
  for (const item of found.items) {
    if (typeof item.sk !== "string" || typeof item.dueAt !== "number" || item.dueAt > nowMs || typeof item.occurrence !== "string") continue;
    ran += 1;
    const result = await erasePerson(deps, orgId, item.who as ErasedPerson, item.occurrence, DEFAULT_ERASE_BUDGET, { sweep: true });
    if (result.complete) { await deleteItem(deps.table, { pk: teamRecordPk(orgId), sk: item.sk }); final += 1; }
    else {
      await deps.table.documentClient.send(new PutCommand({ TableName: deps.table.tableName, Item: { ...item, dueAt: nowMs + ERASE_SWEEP_DELAY_MS, indexExpiresAt: sweepExpiry(nowMs + ERASE_SWEEP_DELAY_MS) } }));
      // SRL-6: an erase whose second pass found work it could not finish is STUCK, though nothing threw: counted once for each run that finds it so, for the company's Health page.
      await recordOpsFailure(deps.table, orgId, "erase_sweep", nowMs);
    }
  }
  return { ran, final };
}

/** What a step needs. */
interface EraseContext {
  deps: PurgeDependencies; orgId: OrgId; who: ErasedPerson; ids: readonly string[]; identities: ReadonlyArray<{ system: string; sourceId: string }>;
  rows: readonly Item[]; links: readonly Item[]; at: string; occurrence: string; budget: EraseBudget; queue: ReturnType<typeof tableLakeDeleteQueue>;
  lessonsFailed?: boolean;
  lessonsPurged: number;
  /** ERASE-NAME-1: set once the Asks step has kept the keyed hashes of the person's names (it writes them first). The `names` step destroys those names, so it waits for this. */
  aliasesKept?: boolean;
}

const developerOf = (context: EraseContext): string => context.who.developerId ?? `source:${context.identities[0]?.system ?? "x"}:${context.identities[0]?.sourceId ?? "x"}`;

/** The projects an erase must cover: the ones passed, the org's project list, and those of the person's rows. `known` is false when none of the first two exists (the org's projects cannot be enumerated). */
async function projectsOf(context: EraseContext): Promise<{ projects: string[]; known: boolean }> {
  const listed = (await context.deps.projects?.projects(context.orgId)) ?? undefined;
  return {
    projects: [...new Set([...(context.who.projects ?? []), ...(listed ?? []), ...context.rows.flatMap((row) => (typeof row.project === "string" ? [row.project] : []))])],
    known: context.who.projects !== undefined || listed !== undefined,
  };
}

/** One handler per step of the registry. `rows` is run by `erasePerson` itself, last. */
const STEP_HANDLERS: Record<Exclude<EraseStep, "rows">, (context: EraseContext) => Promise<boolean>> = {
  // The lake forgets the person's rows by actor (the lake holds no principal list and no actor field in structured_json: see `lakeAcl` and `withoutActorFields`).
  async lake(context) {
    await context.queue.enqueue(context.orgId, [
      ...(context.who.developerId === undefined ? [] : [{ kind: "actor" as const, developerId: recordDeveloperHash(context.who.developerId) }]),
      ...context.identities.map((identity) => ({ kind: "actor_source" as const, hash: recordActorSourceHash(identity.system, identity.sourceId) })),
    ]);
    return true;
  },
  // Row snapshots: the places of the person's own rows, `who.scopes`, and every unit header of the org that names them (below, with the access step).
  async principals(context) {
    const explicit = [...new Set([...(context.who.scopes ?? []), ...context.rows.flatMap((row) => (typeof row.scope === "string" ? [row.scope] : [])), ...context.links.flatMap((link) => (typeof link.scope === "string" ? [link.scope] : []))])].sort();
    if (context.ids.length === 0) return true;
    return scrubExplicitPlaces(context.deps, context.orgId, explicit, context.ids, context.occurrence, context.at, context.budget);
  },
  // Access records: for each unit the person is indexed in (an entry, or a row snapshot that named them), clean the place, then delete the entry and the index item.
  async access(context) {
    if (context.ids.length === 0) return true;
    return scrubAccessUnits(context.deps, context.orgId, context.ids, context.at, context.budget);
  },
  async config(context) {
    // Every project of the org, like the lessons step: the ones passed, the project list, and those of the person's rows. Without a way to enumerate them it is not done.
    const { projects, known } = await projectsOf(context);
    for (const project of projects) {
      for (const config of await listSourceConfigs(context.deps.table, context.orgId, project)) {
        await removeFromExclude(context.deps.table, config, new Set(context.ids));
        if (context.who.developerId !== undefined) await scrubConfigDeveloper(context.deps.table, config, context.who.developerId);
      }
      if (context.who.developerId !== undefined) await scrubTier0Developer(context.deps.table, context.orgId, project, context.who.developerId);
    }
    // The company's own tier-0 floor and proposals live in the workspace's project-less partition.
    if (context.who.developerId !== undefined) await scrubTier0Developer(context.deps.table, context.orgId, undefined, context.who.developerId);
    // SRL-9: the items that carry the developer id (record searches and the source picker's rate items in the sort key, the picker's listing sessions as a hash) and the slack-add rate items keyed by a hash of a
    // Slack user id. They expire within hours, but an unkeyed hash of an enumerable id is personal data, so an erase still covers them. A failure here FAILS the config step on purpose (privacy over best
    // effort): the step is reported unfinished and the next run, and the delayed second pass, try again.
    await eraseRateItems(context.deps.table, context.orgId, context.who.developerId, context.ids);
    // Their favourite agents (experience decision 23): one item whose key holds their developer id; it goes whole (the value is only agent ids, nobody else's).
    if (context.who.developerId !== undefined) await deleteItem(context.deps.table, agentFavouritesKey(context.orgId, context.who.developerId));
    return known;
  },
  // Lessons: those that rest on the person are HARD-deleted whatever their code citations say, the person is scrubbed from the rest (authorship, approvals), and the id leaves every
  // audience snapshot. It covers every project of the org: the ones passed, the ones the project list names, and those of the person's rows; with none of the first two it is not done.
  async lessons(context) {
    const { deps, orgId } = context;
    const { projects, known } = await projectsOf(context);
    if (deps.lessons === undefined) return projects.length === 0 && known;
    // the ids of what is being deleted: the person's rows and the facts derived from them (a lesson resting only on these came from them)
    const rowIds = new Set([...context.rows.flatMap((row) => (typeof row.id === "string" ? [row.id] : [])), ...context.links.flatMap((link) => (typeof link.factId === "string" ? [link.factId] : []))]);
    for (const project of projects) {
      context.lessonsPurged += (await deps.lessons.erasePerson(orgId, project, { developerId: developerOf(context) }, rowIds)).purged.length;
      if (context.ids.length > 0) await deps.lessons.scrubAudienceIds(orgId, project, context.ids);
    }
    return known;
  },
  // Live interaction Asks (agent-sessions/ask-erase.ts): the person's own Asks are deleted and their label in other people's stored text becomes "@former-member". The Ask records live in the same State
  // table as the team record, so no port is needed. Bounded passes, called again until nothing is left or the run's budget is spent; not done means the next run resumes it.
  async asks(context) {
    if (context.who.developerId === undefined) return true;
    // Their aliases are remembered first (30 days at most), so an answer in flight cannot write them while their Asks are being removed.
    // Their names come from the caller and from the name they chose themselves (the State table); everything is hashed with the install's key before it is kept, and none of it is kept raw.
    let chosenUnread = false;
    const chosen = await readOwnChosenName(context.deps.table.documentClient, context.deps.table.tableName, context.who.developerId).catch(() => { chosenUnread = true; return undefined; });
    await rememberErasedAliases(context.deps.table, context.orgId, { developerId: context.who.developerId, names: [...(context.who.names ?? []), ...(chosen === undefined ? [] : [chosen])], handles: context.ids }, Date.parse(context.at) || Date.now(), context.deps.askAliasKey);
    // The keyed hashes are kept; only now may the `names` step destroy the names (not when a name could not be read: the retry hashes it first).
    if (!chosenUnread && context.who.namesUnread !== true) context.aliasesKept = true;
    for (let pass = 0; pass < ASK_ERASE_PASSES_PER_RUN; pass += 1) {
      const result = await eraseAskPerson(context.deps.table, context.orgId, context.who.developerId, { maxItems: Math.min(context.budget.maxItems, 200) }, context.ids);
      if (result.complete) return true;
    }
    return false;
  },
  // ERASE-NAME-1: after the Asks step (which hashes the person's names first): the chosen name becomes a tombstone and the sign-in record's name the placeholder. Absent port: nothing to erase.
  async names(context) {
    if (context.who.developerId === undefined || context.deps.names === undefined) return true;
    // ERASE-NAME-1: the names go only after the Asks step kept their hashes; a run where it did not leaves them for the retry.
    if (context.aliasesKept !== true) return false;
    await context.deps.names.erase(context.who.developerId);
    return true;
  },
  // Live interaction Fix with agent (diagnosis/store.ts): each diagnosis they asked for is deleted (its model text can hold a name; DG-1 S5) with its person-link row, then the index. Bounded passes; not done
  // means the next run resumes it.
  async diagnoses(context) {
    if (context.who.developerId === undefined) return true;
    for (let pass = 0; pass < ASK_ERASE_PASSES_PER_RUN; pass += 1) {
      const result = await eraseDiagnosisPerson(context.deps.table, context.orgId, context.who.developerId, { maxItems: Math.min(context.budget.maxItems, 200) });
      if (result.complete) return true;
    }
    return false;
  },
  // Enterprise foundations I3: the change requests that name the person (their commits carry only a random reference, cut here) are rewritten to "a former member". A person with no
  // developer id (a source identity only) is named on no change request. A failure leaves the step unfinished: the person's attribution rows are still there for the next run.
  async attribution(context) {
    if (context.who.developerId === undefined || context.deps.attribution === undefined) return true;
    await context.deps.attribution.erase(context.orgId, context.who.developerId);
    return true;
  },
  // Test services slice 3 (M3): the person's id leaves the answer-set rows (submittedBy, decidedBy, withdrawnBy) in the State table. A person with no developer id is named in none.
  async fixtures(context) {
    if (context.who.developerId === undefined) return true;
    return scrubFixtureDevelopers({ documentClient: context.deps.table.documentClient, tableName: context.deps.table.tableName, ...(context.deps.now === undefined ? {} : { now: context.deps.now }) }, context.orgId, context.who.developerId, (context.deps.now ?? Date.now)() + (context.budget.maxMs ?? SCRUB_MS_PER_RUN));
  },
};

/** The most pages (500 items each) of one prefix an erase walks; past it the step fails and the next run goes on. */
const RATE_ERASE_MAX_PAGES = 100;
/** Slack user ids as slack-add keys them (a rate item is keyed by a hash of the bare id). A source id that is not shaped like one is not a candidate. */
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,31}$/u;

/**
 * Deletes every item under `prefix` whose sort key continues with `tail` (the rest after the prefix must be exactly the writer's shape, so an id that merely starts with this one, or contains `#`, is never touched),
 * a page at a time until the query is no longer truncated (what is deleted no longer shows up, so the next query reads the rest). A full page that deletes nothing cannot make progress: the step fails.
 */
async function deleteAllUnder(table: PurgeDependencies["table"], orgId: OrgId, prefix: string, tail: RegExp): Promise<void> {
  for (let page = 0; page < RATE_ERASE_MAX_PAGES; page += 1) {
    const { items, truncated } = await queryPrefix(table, orgId, undefined, prefix, 500);
    let deleted = 0;
    for (const item of items) {
      if (typeof item.pk !== "string" || typeof item.sk !== "string" || !tail.test(item.sk.slice(prefix.length))) continue;
      await deleteItem(table, { pk: item.pk, sk: item.sk });
      deleted += 1;
    }
    if (!truncated) return;
    if (deleted === 0) break;
  }
  throw new Error("erase: too many rate items");
}
/** The window a rate item ends with: `#<digits>`. A person's item is `<prefix><window digits>` (the prefix ends in `#`); a slack-add item has the channel first. */
const RATE_WINDOW = /^\d+$/u;
const SLACK_ADD_TAIL = /^[^#|]+#\d+$/u;

/**
 * Removes the person's rate items (`RATE#<what>|person:<id>#<window>`; each window expires within hours), the slack-add rate items of each of their Slack ids (`RATE#slack-add|<hash>|<channel>#<window>`) and the
 * picker listing sessions they opened (`SRCOPT#`, whose `person` is a hash of the company and the developer id).
 */
async function eraseRateItems(table: PurgeDependencies["table"], orgId: OrgId, developerId: string | undefined, sourceIds: readonly string[]): Promise<void> {
  if (developerId !== undefined) {
    for (const what of PERSON_RATE_KINDS) await deleteAllUnder(table, orgId, personRatePrefix(what, developerId), RATE_WINDOW);
    // Sessions expire in 15 minutes, so the company has few; if the query still cannot read them all, the step fails and is repeated.
    const wanted = pickerPersonHash(orgId, developerId);
    const sessions = await queryPrefix(table, orgId, undefined, SOURCE_OPTIONS_SK_PREFIX, 5_000);
    for (const item of sessions.items) if (item.person === wanted && typeof item.sk === "string") await deleteItem(table, { pk: teamRecordPk(orgId), sk: item.sk });
    if (sessions.truncated) throw new Error("erase: too many picker sessions");
  }
  for (const id of new Set(sourceIds.filter((value) => SLACK_USER_ID.test(value)))) await deleteAllUnder(table, orgId, slackAddRatePrefix(orgId, id), SLACK_ADD_TAIL);
}

/** The most passes of the Ask erasure in one erase run (each pass handles up to 200 Asks and 200 mentions). */
const ASK_ERASE_PASSES_PER_RUN = 25;

const ERASE_PROGRESS_PREFIX = "ERASEPROG#";

/** The explicit list of places, scrubbed a budget at a time: where it stopped is kept on a progress item, so a person in thousands of places completes over several runs. */
async function scrubExplicitPlaces(deps: PurgeDependencies, orgId: OrgId, places: readonly string[], ids: readonly string[], occurrence: string, at: string, budget: EraseBudget): Promise<boolean> {
  const progressKey = { pk: teamRecordPk(orgId), sk: `${ERASE_PROGRESS_PREFIX}${occurrence}` };
  const saved = await deps.table.documentClient.send(new GetCommand({ TableName: deps.table.tableName, Key: progressKey, ConsistentRead: true })) as { Item?: { next?: unknown } };
  let next = typeof saved.Item?.next === "number" ? saved.Item.next : 0;
  const stop = (deps.now ?? Date.now)() + (budget.maxMs ?? SCRUB_MS_PER_RUN);
  while (next < places.length && (deps.now ?? Date.now)() < stop) {
    if (!(await scrubPlace(deps, orgId, places[next] as string, ids, at, budget, stop))) break;
    next += 1;
  }
  if (next >= places.length) { await deleteItem(deps.table, progressKey); return true; }
  await deps.table.documentClient.send(new PutCommand({ TableName: deps.table.tableName, Item: { ...progressKey, entityType: "TEAM_RECORD_ERASE_PROGRESS", next } }));
  return false;
}
const SCRUB_MS_PER_RUN = 20_000;

/** One place: its ids leave every row, walked from a cursor until the pass is complete or the run's time is spent. True when complete. */
async function scrubPlace(deps: PurgeDependencies, orgId: OrgId, scope: string, ids: readonly string[], at: string, budget: EraseBudget, stop: number): Promise<boolean> {
  let cursor: ScopeCursor | undefined;
  for (;;) {
    if ((deps.now ?? Date.now)() >= stop) return false;
    const done = await changeScopePrincipals({ table: deps.table, ...(deps.now === undefined ? {} : { now: deps.now }) }, orgId, { scope, remove: ids, at }, { maxItems: budget.maxItems, maxMs: 8_000 }, cursor);
    if (done.complete) return true;
    cursor = done.cursor;
    if (cursor === undefined) return false;
  }
}

/** Each unit the person is in: the rows of its place lose the id, then the person's entry and index item go. Returns true when no unit is left. */
async function scrubAccessUnits(deps: PurgeDependencies, orgId: OrgId, ids: readonly string[], at: string, budget: EraseBudget): Promise<boolean> {
  const stop = (deps.now ?? Date.now)() + (budget.maxMs ?? SCRUB_MS_PER_RUN);
  for (const id of ids) {
    for (;;) {
      const { units, truncated } = await unitsOfPerson(deps.table, orgId, id, Math.min(budget.maxItems, 200));
      if (units.length === 0) break;
      for (const unit of units) {
        if ((deps.now ?? Date.now)() >= stop) return false;
        if (unit.scope !== undefined) {
          if (!(await scrubPlace(deps, orgId, placeOfUnit(unit.scope), [id], at, budget, stop))) return false;
        }
        await removePersonFromUnit(deps.table, orgId, id, unit.unitHash);
      }
      if (!truncated && units.length < Math.min(budget.maxItems, 200)) break;
    }
  }
  return true;
}

/** Everything that lives in a project's partition besides rows, derivation links, facts and source settings: the learning lane's lessons, skills, manifests, snapshots and settings, and the source write route's request items. */
const LEARNING_PREFIXES = [LESSON_SK_PREFIX, "SKILL#", "LOAD#", "EVALLOAD#", "SNAPSHOT#", "LESSONSET", "MODE", SOURCE_REQUEST_SK_PREFIX, SOURCE_REVISION_SK_PREFIX] as const;
const ALL_PREFIXES = ["SOURCE#", RECORD_EVENT_SK_PREFIX, "DERIV#", RECORD_FACT_SK_PREFIX, ...LEARNING_PREFIXES] as const;
/** The workspace's own items: the delete queue, rate counters, failure counters (`OPSFAIL#`), deleted-at-source markers and the company mode lock. (`LAKEDEL#` stays until the lake job has run.) `EDITED#` marks were the freeze-on-edit rule's (replaced by per-editor rows): nothing writes or reads them any more, and a company erase still removes any left over. */
const WORKSPACE_PREFIXES = ["DELQ#", "RATE#", "DELETED#", "MODE_LOCK", "VECBUCKET", "ITEM#", "SCOPEDEL#", "ACCESS#", "ACCESSP#", "ERASED#", "ERASESWEEP#", "ERASEPROG#", "TRLINK#", "TRLINKDEV#", "TRUNMATCHED#", "TRUNMAP#", "TRSYNC#", "TRREQ#", "PRIOREDIT#", PUSH_INDEX_SK_PREFIX, MERGE_INDEX_SK_PREFIX, "TRAUTOLINK", "SKIPPED#", "EDITED#", SOURCE_SCOPE_SK_PREFIX, SOURCE_OPTIONS_SK_PREFIX, SLACK_ADD_SK_PREFIX, OPS_FAILURE_SK_PREFIX] as const;

/**
 * A project is archived or a workspace closed: the project's partition is emptied. Its source rows go first, so no tap writes into it again; then rows and facts
 * (with vectors, the lake queue and lessons through `purgeItems`: a fact is deleted, never re-distilled, here), then everything the learning lane keeps there.
 * Each call removes up to the budget; call again until `complete`. `project` undefined is the workspace's project-less partition.
 */
export async function eraseProject(deps: PurgeDependencies, orgId: OrgId, project: string | undefined, cause: "project_archived" | "org_closed", occurrence: string, budget: EraseBudget = DEFAULT_ERASE_BUDGET): Promise<EraseResult> {
  const now = deps.now ?? Date.now;
  const queue = deps.lakeQueue ?? tableLakeDeleteQueue(deps.table, now);
  // The whole partition goes, so nothing is re-distilled from what is left.
  const wiping: PurgeDependencies = { ...deps, redistil: undefined, audit: undefined };
  const pk = teamRecordPk(orgId, project);
  const result: EraseResult = { ...emptyPurge(), other: 0, complete: false };
  let left = budget.maxItems;
  const take = (prefix: string): Promise<{ items: Item[]; truncated: boolean }> => queryPrefix(deps.table, orgId, project, prefix, Math.max(left, 1));
  const removePlain = async (items: readonly Item[]): Promise<void> => {
    for (const item of items) if (typeof item.sk === "string") await deleteItem(deps.table, { pk, sk: item.sk });
  };

  // 1. Sources first: nothing new arrives once they are gone.
  const sources = await take("SOURCE#");
  // A project's places are free again for another project: each source row's claim goes before the row (a repeat after a crash finds the row and drops the claim again).
  if (project !== undefined) for (const item of sources.items) if (typeof item.source === "string" && typeof item.scope === "string") await dropScopeClaim(deps.table, orgId, project, item.source, item.scope);
  await removePlain(sources.items);
  left -= sources.items.length;
  result.other += sources.items.length;

  // 1b. The pickers' listing sessions of this project (`SRCOPT#`) sit in the company's project-less partition, so the prefix walk below never finds them; they hold only the project's name and a page count and
  // expire by themselves after 15 minutes. Found by their `project` field and removed with the project (the first 500 of the company's sessions; any left expire on their own).
  if (project !== undefined) {
    const sessions = await queryPrefix(deps.table, orgId, undefined, SOURCE_OPTIONS_SK_PREFIX, 500);
    for (const item of sessions.items) if (item.project === project && typeof item.sk === "string") await deleteItem(deps.table, { pk: teamRecordPk(orgId), sk: item.sk });
  }

  // 2. The lake: the whole project is queued before any hot row goes.
  if (project !== undefined) await queue.enqueue(orgId, [{ kind: "project", project }]);

  // 3. Rows and derivation links, then the facts that have no link left.
  for (const prefix of [RECORD_EVENT_SK_PREFIX, "DERIV#"]) {
    if (left <= 0) break;
    const found = await take(prefix);
    left -= found.items.length;
    const purged = await purgeItems(wiping, orgId, found.items);
    Object.assign(result, addPurge(result, purged), { other: result.other });
  }
  if (left > 0) {
    const facts = await take(RECORD_FACT_SK_PREFIX);
    left -= facts.items.length;
    const keys = facts.items.flatMap((item) => (typeof item.id === "string" ? [`fact:${item.id}`] : []));
    const failed = keys.length === 0 ? [] : deps.vectors === undefined ? keys : await deps.vectors.delete(keys).then((response) => response.failed, () => keys);
    for (const item of facts.items) {
      if (typeof item.sk !== "string") continue;
      if (typeof item.id === "string" && failed.includes(`fact:${item.id}`)) { result.blocked += 1; continue; }
      await deleteItem(deps.table, { pk, sk: item.sk });
      result.facts += 1;
      if (typeof item.id === "string") result.vectors += 1;
    }
  }

  // 4. What the learning lane keeps there. Lesson vectors go BEFORE the lesson rows (the same order as everywhere else): a vector that cannot be deleted keeps its
  // lesson rows, so the next call finds them again, and a missing vector port counts as blocked while lessons exist.
  const lessons = await take(LESSON_SK_PREFIX);
  const lessonIds = new Set(lessons.items.flatMap((item) => (typeof item.sk === "string" ? [/^LESSON#([^#]+)/.exec(item.sk)?.[1]] : [])).filter((id): id is string => id !== undefined));
  let lessonVectorsGone = lessonIds.size === 0;
  if (lessonIds.size > 0 && project !== undefined && deps.lessonVectors !== undefined) {
    lessonVectorsGone = await deps.lessonVectors.removeAll(orgId, project, [...lessonIds]).then(() => true, () => false);
  }
  if (!lessonVectorsGone) result.blocked += lessonIds.size;
  else {
    left -= lessons.items.length;
    await removePlain(lessons.items);
    result.other += lessons.items.length;
  }
  for (const prefix of LEARNING_PREFIXES.filter((candidate) => candidate !== LESSON_SK_PREFIX)) {
    if (left <= 0) break;
    const found = await take(prefix);
    left -= found.items.length;
    await removePlain(found.items);
    result.other += found.items.length;
  }

  // Complete when a fresh look finds nothing left and nothing was blocked.
  let remaining = 0;
  for (const prefix of ALL_PREFIXES) remaining += (await queryPrefix(deps.table, orgId, project, prefix, 1)).items.length;
  result.complete = remaining === 0 && result.blocked === 0;
  await finish(deps, orgId, cause, occurrence, result);
  return result;
}

/**
 * A workspace is closed: every project's partition and the workspace's own (the delete queue, rate counters, markers, the mode lock) are emptied. `projects` is the
 * org's project list (the catalog the org close already walks); the project-less partition is always included. The lake queue is left until the lake job has run.
 */
export async function eraseWorkspace(deps: PurgeDependencies, orgId: OrgId, projects: readonly string[], occurrence: string, budget: EraseBudget = DEFAULT_ERASE_BUDGET): Promise<EraseResult & { remainingProjects: string[] }> {
  const total: EraseResult = { ...emptyPurge(), other: 0, complete: true };
  // The whole workspace in the lake first, including rows that belong to no project (the per-project target cannot reach those).
  await (deps.lakeQueue ?? tableLakeDeleteQueue(deps.table, deps.now)).enqueue(orgId, [{ kind: "workspace" }]);
  let left = budget.maxItems;
  const remainingProjects: string[] = [];
  for (const project of [...projects, undefined]) {
    if (left <= 0) { if (project !== undefined) remainingProjects.push(project); total.complete = false; continue; }
    const done = await eraseProject({ ...deps, audit: undefined }, orgId, project, "org_closed", occurrence, { maxItems: left });
    left -= done.rows + done.facts + done.other + 1;
    Object.assign(total, addPurge(total, done), { other: total.other + done.other, complete: total.complete && done.complete });
    if (!done.complete && project !== undefined) remainingProjects.push(project);
  }
  if (total.complete) {
    for (const prefix of WORKSPACE_PREFIXES) {
      const own = await queryPrefix(deps.table, orgId, undefined, prefix, 500);
      for (const item of own.items) if (typeof item.sk === "string") await deleteItem(deps.table, { pk: teamRecordPk(orgId), sk: item.sk });
      total.other += own.items.length;
      if (own.truncated) total.complete = false;
    }
  }
  const result = { ...total, remainingProjects };
  await finish(deps, orgId, "org_closed", occurrence, result);
  return result;
}

/** The steps this module runs (the registry guard test checks that every step the registry names has a handler). */
export const ERASE_HANDLED_STEPS: readonly EraseStep[] = [...(Object.keys(STEP_HANDLERS) as EraseStep[]), "rows"];
