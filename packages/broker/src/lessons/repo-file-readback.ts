// Lessons in the repo, lane R3 (owner decisions 50, 50a, 50b; LESSONS-REPO-FILE-DESIGN.md rev 2 section 6): read-back. The merged `.rovara/lessons.md` is the team's, so what the team does to it in git is taken into Rovara, ONE WAY
// (file -> Rovara), once per weekly pass, from the file the pass already read on the default branch (no new read, no new loop). It is pure text: NO model call (decision 47), no host, no clock but the one it is given.
//   - A block whose text changed under a known id is the team's CORRECTION: the lesson's text becomes theirs, as a person edit (audited; actor is the commit author when the install can map one to a member, else "repository edit").
//     The lesson stays repository-only for this repository (the text is repository content), harm marks from before the edit are cleared, help counts kept, and R2's hand-edit hold is released (the fingerprint Rovara
//     remembers for the block becomes the team's, so Rovara treats the wording as its own and never overwrites it).
//   - A known id missing from the file is RETIRED BY THE TEAM (reason "removed in the repository", audited). R2 never proposes it back.
//   - A bullet with no id line is a NEW lesson, person-approved, repository-only for this repository, made from the text (cleaned, capped). A text that names a person, asks for a capability change, or is empty is NOT taken in; the
//     line's fingerprint and a fixed reason are recorded (once). The next weekly pull request puts an id line before the team's bullet (`repo-file-plan.ts`), and does not touch the bullet.
//   - An id that is gone for good in Rovara (erased, withdrawn, purged) is NEVER touched here, whatever the file says: the erasure sweep owns it, independently (a block carrying it is for R2/the sweep to remove).
//   - Formatters are tolerated: texts are compared in normal form (whitespace, wrapping, bullet marker, CRLF, NFC); a change only in those is not an edit. Ids stripped by a tool that drops HTML comments are re-attached by exact text
//     (nothing is retired). A file that cannot be trusted as read (not valid text, or one that lost EVERY marker while Rovara expects some) is UNREADABLE: nothing at all is changed this pass.
//   - It acts only on what it can prove: a lookup that fails throws and changes nothing further; a lesson changed between the read and the write is a conflict that ends the pass (nothing is half-recorded: every step is repeatable).
import { createHash } from "node:crypto";
import { cleanForLearning, requestsCapabilityChange } from "./guards.js";
import { defaultLessonId, retireLesson } from "./curate.js";
import { firstExpiry } from "./expiry.js";
import { emitAudit, requireAudit } from "./policy.js";
import type { LessonAuditSink } from "./ports.js";
import { TEAM_FILE_TEXT } from "./repo-eligibility.js";
import {
  WHOLE_REPOSITORY, cleanLessonLine, looseItems, normalizeBlockText, parseLessonsFile, textHash, type LooseItem,
} from "./repo-file-format.js";
import { MAX_REFUSED, type ReadBackRefusal } from "./repo-file-state.js";
import { nextVersion, type LessonStore, type ScopeKey } from "./store.js";
import { classifyTier } from "./tier.js";
import { namesAPerson } from "./trial.js";
import { LessonSchema, distinctIds, type Lesson } from "./types.js";

/** The actor of an edit or a retirement the install cannot tie to a member. */
export const REPOSITORY_EDIT_ACTOR = "repository edit";
/** The `by` of the approval a read-back gives (not a person's id: it names no one and is never counted as a person to erase). */
const APPROVAL_BY = "system:repository-edit";
/** The cause the ledger records on a retirement the team made by removing the block. */
export const REMOVED_IN_REPOSITORY = "removed_in_repository";
/** New lessons taken in from one file in one pass (the rest wait for the next pass). */
export const MAX_IMPORTS_PER_PASS = 50;
const MAX_TRIES = 3;
const INERT = new Set<Lesson["status"]>(["retired", "rejected", "withdrawn"]);
const FINGERPRINT = /^([0-9a-f]{16}):([0-9a-f]{8})$/u;

/** A fault that ends the pass with this problem code (nothing is half-done: the next pass repeats whatever was not finished). */
export class ReadBackFailure extends Error { constructor(readonly problem: "audit_down" | "conflict" | "repository_unreadable") { super(problem); this.name = "ReadBackFailure"; } }

export interface ReadBackDeps {
  store: LessonStore;
  audit: LessonAuditSink;
  now: () => number;
  newId?: () => string;
  /** The member (canonical developer id) who made the commit the file's text came from, when the install can tie it to one: undefined otherwise. Never throws into the read-back. */
  editorOf?: (place: string, revision: string) => Promise<string | undefined>;
}

export interface ReadBackInput {
  key: ScopeKey; place: string; repoName: string;
  /** The default branch's file text, and the revision it was read at. */
  fileText: string; revision: string;
  /** What Rovara remembers: the fingerprints of the blocks it merged, and the lines it already refused. */
  rendered: Readonly<Record<string, string>>; refused: Readonly<Record<string, ReadBackRefusal>>;
  /** Every lesson of the project (any status); lessons of other repositories are ignored. */
  lessons: readonly Lesson[];
  /** Ids gone for good in Rovara (the lesson store's tombstones): never touched. */
  gone: ReadonlySet<string>;
  /** The people the text could name (display names). */
  names: readonly string[];
}

export interface ReadBackResult {
  /** The file cannot be trusted as read: nothing was changed. */
  unreadable: boolean;
  /** Fingerprints to record for blocks whose wording is now the team's (or that Rovara adopted): id to fingerprint. */
  rendered: Record<string, string>;
  /** The refused lines after this pass (old ones kept, bounded). */
  refused: Record<string, ReadBackRefusal>;
  counts: { edited: number; retired: number; imported: number; refused: number };
}

/** The hash of a lesson's text as the file shows it. */
const hashOfBody = (body: string): string => textHash(normalizeBlockText(cleanLessonLine(body)));
const hashOfBlock = (text: string): string => textHash(normalizeBlockText(text));

/** The text the file does not make safe: bytes that were not valid text come out as U+FFFD, and NUL is never in a text file. */
const isMalformed = (text: string): boolean => text.includes("\u0000") || text.includes("�");

/** The scope a section heading names, the reverse of `sectionOf`: the whole repository, `Languages: a, b`, `path, path` and `path (lang, lang)`. A heading of the team's own is the whole repository. */
export function scopeOfHeading(heading: string, repoName: string): Lesson["scope"] {
  const base: Lesson["scope"] = { repos: [repoName] };
  if (heading === WHOLE_REPOSITORY) return base;
  const PATH = /^[A-Za-z0-9_./*@-]{1,100}$/u;
  const LANG = /^[a-z][a-z0-9+#-]{0,19}$/u;
  const list = (text: string): string[] => text.split(",").map((part) => part.trim());
  const onlyLanguages = /^Languages:\s*(.+)$/u.exec(heading);
  if (onlyLanguages !== null) { const languages = list(onlyLanguages[1]!); return languages.length <= 10 && languages.every((l) => LANG.test(l)) ? { ...base, languages } : base; }
  const withLanguages = /^(.+?) \(([^()]+)\)$/u.exec(heading);
  const pathText = withLanguages === null ? heading : withLanguages[1]!;
  const paths = list(pathText);
  const languages = withLanguages === null ? [] : list(withLanguages[2]!);
  // A path names a file or folder (a slash, a star or a dot): a one-word heading of the team's own ("Testing") is not a path.
  if (paths.length === 0 || paths.length > 20 || !paths.every((p) => PATH.test(p) && /[/*.]/u.test(p) && !p.includes("..")) || languages.length > 10 || !languages.every((l) => LANG.test(l))) return base;
  return { ...base, paths, ...(languages.length === 0 ? {} : { languages }) };
}

/** The part of a fingerprint that stands for the section heading (`repo-file-plan.ts#fingerprintOf`). */
const hashOfHeading = (heading: string): string => createHash("sha256").update(heading).digest("hex").slice(0, 8);

const titleOf = (text: string): string => Array.from(text).slice(0, 80).join("").trim();

type Decision = { ok: true; body: string } | { ok: false; reason: ReadBackRefusal };
/** What a line of the file may become as a lesson's text: cleaned like every lesson text, and refused when it is empty, names a person or asks for a capability change. Pure. */
function admit(text: string, names: readonly string[]): Decision {
  const body = cleanForLearning(cleanLessonLine(text), 600);
  if (body === "") return { ok: false, reason: "empty" };
  if (requestsCapabilityChange(titleOf(body), "", body)) return { ok: false, reason: "capability_request" };
  if (namesAPerson(body, names)) return { ok: false, reason: "names_a_person" };
  return { ok: true, body };
}

/** The sink's failure to take an event that a grant needs is a failure of the pass, before anything is changed for that lesson. */
async function audited(deps: ReadBackDeps, event: Parameters<typeof requireAudit>[1]): Promise<void> {
  if (!await requireAudit(deps.audit, event)) throw new ReadBackFailure("audit_down");
}

async function editorOf(deps: ReadBackDeps, place: string, revision: string): Promise<string | undefined> {
  if (deps.editorOf === undefined) return undefined;
  try { return await deps.editorOf(place, revision); } catch { return undefined; }
}

/** The lessons that must be in the file: Rovara merged them and they are alive. A lesson that is gone, retired or unknown is not expected (nothing of it is lost if its marker is). */
function expectedIds(input: ReadBackInput, byId: ReadonlyMap<string, Lesson>): string[] {
  return Object.keys(input.rendered).filter((id) => { const lesson = byId.get(id); return lesson !== undefined && !INERT.has(lesson.status) && !input.gone.has(id); });
}

async function editLesson(deps: ReadBackDeps, key: ScopeKey, id: string, body: string, actor: string, member: string | undefined): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const fresh = await deps.store.get(key, id);
    if (fresh === undefined || fresh.status !== "active") return false;
    const now = deps.now();
    if (fresh.body === body && fresh.approvals.some((a) => a.by === APPROVAL_BY || a.by === member) && fresh.tierReasons.includes(TEAM_FILE_TEXT)) return true;
    const title = titleOf(body);
    const working: Lesson = { ...fresh, title, description: "", body };
    // The tier is worked out again on the team's words (an edit can raise a tier, never lower it); the lesson keeps being the team's text (`TEAM_FILE_TEXT`), so R2 never takes the block out for its tier.
    const decision = classifyTier({ ...working, provenance: working.provenance }, { contradiction: fresh.contradictsWith !== undefined }, { tier: fresh.tier, reasons: fresh.tierReasons.filter((r) => r !== TEAM_FILE_TEXT) });
    if (decision.tier === "never") return false;
    // A person's edit is a new text: the approvals given to the old text do not carry over. The team's merge is the approval, and a trial it was on is over.
    const approval = { approvalId: (deps.newId ?? defaultLessonId)(), by: member ?? APPROVAL_BY, at: now, mode: "one" as const };
    const provenance = { ...fresh.provenance, ...(member === undefined ? {} : { editors: distinctIds([...(fresh.provenance.editors ?? []), member]) }) };
    const next: Lesson = {
      ...working, version: nextVersion(fresh, await deps.store.versions(key, id)), tier: decision.tier, tierReasons: [...new Set([...decision.reasons, TEAM_FILE_TEXT])].slice(0, 12),
      approvals: [approval], provenance, updatedAt: now,
    };
    delete (next as { trial?: Lesson["trial"] }).trial;
    delete (next as { reviewRequired?: boolean }).reviewRequired;
    await audited(deps, { action: "lesson.updated", workspaceId: key.workspaceId, project: key.project, lessonId: id, actor, facts: { tier: decision.tier, fromTier: fresh.tier, cause: "repository_edit" } });
    const result = await deps.store.commit(key, await deps.store.setVersion(key), [next], now);
    if (!result.ok) continue;
    // Harm marks from before the edit are cleared (the team has read and reworded it), help counts are kept.
    await deps.store.mutate(key, id, (l) => ({ ...(l.counters.harmful > 0 ? { counters: { ...l.counters, harmful: 0 } } : {}), ...(l.retireProposedAt === undefined ? {} : { retireProposedAt: undefined as unknown as number }) }));
    return true;
  }
  return false;
}

async function importLesson(deps: ReadBackDeps, input: ReadBackInput, item: LooseItem, body: string, actor: string, member: string | undefined): Promise<boolean> {
  const { key } = input;
  const now = deps.now();
  const title = titleOf(body);
  const scope = scopeOfHeading(item.heading, input.repoName);
  const stages: Lesson["stages"] = ["UNDERSTAND", "PLAN", "IMPLEMENT"];
  const decision = classifyTier({ type: "convention", stages, scope, citations: [], title, description: "", body, provenance: { minTrust: "member", audience: { kind: "project" } } });
  if (decision.tier === "never") return false;
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const lesson: Lesson = LessonSchema.parse({
      id: (deps.newId ?? defaultLessonId)(), version: 1, workspaceId: key.workspaceId, project: key.project, scope, type: "convention", stages, title, description: "", body, citations: [],
      provenance: {
        sourceEvents: [], sourceKinds: [], authors: [], ...(member === undefined ? {} : { editors: [member] }), supportTasks: [], sources: [], inputSources: [], measured: false, minTrust: "member", audience: { kind: "project" },
        reflectorRun: "repo_file", model: "none", memberSignal: true, sourceScopes: [input.place], repoOnly: { place: input.place },
      },
      tier: decision.tier, tierReasons: [...new Set([...decision.reasons, TEAM_FILE_TEXT])].slice(0, 12), status: "active",
      counters: { loaded: 0, helpful: 0, harmful: 0, citationStale: 0 }, staleAt: [], expiresAt: firstExpiry("convention", now, undefined),
      approvals: [{ approvalId: (deps.newId ?? defaultLessonId)(), by: member ?? APPROVAL_BY, at: now, mode: "one" }], createdAt: now, updatedAt: now,
    });
    await audited(deps, { action: "lesson.activated", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, actor, facts: { tier: lesson.tier, type: lesson.type, approvals: 1, cause: "repository_edit" } });
    const result = await deps.store.commit(key, await deps.store.setVersion(key), [lesson], now);
    if (result.ok) return true;
  }
  return false;
}

/**
 * Reads the team's edits of the merged file back into Rovara (see the header). Never calls a model or a host. Throws `ReadBackFailure` when it could not finish safely; what it finished stays (each step is repeatable, so the next
 * pass completes the rest without doing anything twice).
 */
export async function readBackFile(deps: ReadBackDeps, input: ReadBackInput): Promise<ReadBackResult> {
  const nothing: ReadBackResult = { unreadable: false, rendered: {}, refused: { ...input.refused }, counts: { edited: 0, retired: 0, imported: 0, refused: 0 } };
  if (isMalformed(input.fileText)) return { ...nothing, unreadable: true };
  const { key } = input;
  const file = parseLessonsFile(input.fileText);
  const loose = looseItems(file);
  const looseHashes = new Set(loose.map((item) => textHash(item.text)));
  const mine = input.lessons.filter((lesson) => lesson.provenance.repoOnly?.place === input.place || input.rendered[lesson.id] !== undefined);
  const byId = new Map(mine.map((lesson) => [lesson.id, lesson]));
  const inFile = new Set(file.blocks.map((block) => block.id));

  // A file with NO marker left while Rovara expects some is a file a tool stripped (or an emptied one): readable only if every expected lesson's own text is still there as a bullet (the next pull request puts the ids back).
  // Anything else is unreadable: "the team retired everything" is never concluded from a file that lost all its markers.
  const expected = expectedIds(input, byId);
  if (file.blocks.length === 0 && expected.length > 0 && !expected.every((id) => looseHashes.has(hashOfBody(byId.get(id)!.body)))) return { ...nothing, unreadable: true };

  const result = nothing;
  const refuse = (hash: string, reason: ReadBackRefusal): void => {
    if (result.refused[hash] === reason) return;
    delete result.refused[hash];
    result.refused[hash] = reason;
    result.counts.refused += 1;
  };
  const actors = new Map<string, { actor: string; member: string | undefined }>();
  const actorFor = async (): Promise<{ actor: string; member: string | undefined }> => {
    const cached = actors.get(input.revision);
    if (cached !== undefined) return cached;
    const member = await editorOf(deps, input.place, input.revision);
    const found = { actor: member ?? REPOSITORY_EDIT_ACTOR, member };
    actors.set(input.revision, found);
    return found;
  };

  // 1. Changed text under a known id: the team's correction.
  for (const block of file.blocks) {
    if (file.duplicates.includes(block.id) || input.gone.has(block.id)) continue;
    const lesson = byId.get(block.id);
    // Only a lesson Rovara is using takes the team's wording in; one that is expired, stale or retired keeps its block exactly as the team wrote it (R2's hold) and Rovara's own reasons for it stay as they are.
    if (lesson === undefined || lesson.status !== "active") continue;
    const remembered = input.rendered[block.id];
    const match = remembered === undefined ? null : FINGERPRINT.exec(remembered);
    const baseline = match === null ? hashOfBody(lesson.body) : match[1]!;
    const now = hashOfBlock(block.text);
    if (now === baseline) continue;
    // The heading part stays what Rovara remembered: a block the team only MOVED is not an edit (R2 keeps holding it), and a moved-and-reworded one keeps being a moved one.
    const headingPart = match === null ? undefined : match[2]!;
    const decision = admit(block.text, input.names);
    if (!decision.ok) { refuse(now, decision.reason); continue; }
    const { actor, member } = await actorFor();
    if (!await editLesson(deps, key, block.id, decision.body, actor, member)) throw new ReadBackFailure("conflict");
    result.rendered[block.id] = `${now}:${headingPart ?? hashOfHeading(block.heading)}`;
    result.counts.edited += 1;
  }

  // 2. A known id the file no longer has: retired by the team. Not when its text is still there as a bullet (a tool stripped the marker), and never a lesson that is gone for good (the erasure sweep's).
  for (const id of Object.keys(input.rendered)) {
    if (inFile.has(id) || input.gone.has(id)) continue;
    const lesson = byId.get(id);
    if (lesson === undefined || INERT.has(lesson.status)) continue;
    if (looseHashes.has(hashOfBody(lesson.body))) continue;
    const { actor } = await actorFor();
    await retireLesson({ store: deps.store, now: deps.now, audit: deps.audit }, key, id, REMOVED_IN_REPOSITORY, actor, "lesson.retired", { cause: REMOVED_IN_REPOSITORY });
    const after = await deps.store.get(key, id);
    if (after !== undefined && !INERT.has(after.status)) throw new ReadBackFailure("conflict");
    result.counts.retired += 1;
  }

  // 3. A bullet with no id: a new lesson the team wrote.
  const aliveTexts = new Set(input.lessons.filter((lesson) => !INERT.has(lesson.status) && !input.gone.has(lesson.id)).map((lesson) => hashOfBody(lesson.body)));
  let imports = 0;
  for (const item of loose) {
    const hash = textHash(item.text);
    if (aliveTexts.has(hash) || input.refused[hash] !== undefined) continue;
    if (imports >= MAX_IMPORTS_PER_PASS) break;
    const decision = admit(item.text, input.names);
    if (!decision.ok) { refuse(hash, decision.reason); continue; }
    // The cleaned text may differ from the line (redaction, markup): a lesson with that text already is the same advice.
    const cleanedHash = hashOfBody(decision.body);
    if (aliveTexts.has(cleanedHash)) continue;
    const { actor, member } = await actorFor();
    if (!await importLesson(deps, input, item, decision.body, actor, member)) throw new ReadBackFailure("conflict");
    aliveTexts.add(hash); aliveTexts.add(cleanedHash);
    imports += 1;
    result.counts.imported += 1;
  }

  // Refusals are recorded once and bounded: the oldest go first.
  const entries = Object.entries(result.refused);
  if (entries.length > MAX_REFUSED) result.refused = Object.fromEntries(entries.slice(-MAX_REFUSED));
  // A refusal is told once, in the ledger, fixed words only (best effort: it grants nothing).
  if (result.counts.refused > 0) await emitAudit(deps.audit, { action: "lesson.refused", workspaceId: key.workspaceId, project: key.project, actor: REPOSITORY_EDIT_ACTOR, facts: { reason: "repository_text_not_taken", count: result.counts.refused } });
  return result;
}
