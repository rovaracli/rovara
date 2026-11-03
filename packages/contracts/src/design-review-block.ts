// Design review stage, DR3 (designs-2026-10-30/design-review-stage.md 3.3, 3.5 and 3.12): reading what the review models write, and checking the merge step.
// A reviewer, the merge step and the planner's resolve step are models; what they write is untrusted. Each ends its answer with one fenced JSON block, and this is the one place
// that reads them (the worker asks once more when a block is unreadable; the broker decides). Modelled on `readPlanCritique` (plan-critique-block.ts), but stricter: a block that
// breaks a rule is an error in words the model can fix, never a block with the bad part quietly dropped. Nothing here can approve, lower a risk tier, or set a cost.
// Merge checks (3.5): every raw finding appears in exactly one merged finding, a group holds one section only, a merged finding keeps the highest severity of its raw findings, its text is
// one of its highest-severity raw findings' own words, and its citations are only ever the raw findings' citations. The raw findings' words are kept on the merged finding. A merge that
// fails any check is thrown away for a code-only merge (exact duplicates only, no rewording).
import { z } from "zod";
import { redactText } from "./redaction.js";
import { lastFencedBlock } from "./workflow-proposed-checks.js";
import {
  DESIGN_FINDING_SEVERITIES, DESIGN_REASONS, DESIGN_REVIEW_FINDINGS_MAX, DESIGN_REVIEW_QUESTIONS_MAX, DESIGN_SECTIONS, DesignCitationSchema, DesignQuestionSchema, DesignReasonSchema,
  DesignSectionSchema, REVIEWER_ROLES, designFindingFingerprint, normalizedFindingText, type DesignCitation, type DesignFinding, type DesignQuestion, type ReviewerRole,
} from "./design-review.js";

export const DESIGN_REVIEW_INFO_STRING = "rovara-design-review";
export const DESIGN_META_INFO_STRING = "rovara-design-meta";
export const DESIGN_MERGE_INFO_STRING = "rovara-design-merge";
export const DESIGN_RESOLVE_INFO_STRING = "rovara-design-resolve";
/** The most findings one reviewer may report (3.5). */
export const DESIGN_REVIEW_FINDINGS_PER_REVIEWER_MAX = 15;
/** The most characters of a finding's text (the same as `DesignFindingSchema`). */
export const DESIGN_FINDING_TEXT_MAX_CHARS = 500;
/** The design document's size cap (3.3). Over it, the review says "too long: split the work". */
export const DESIGN_TEXT_MAX_BYTES = 24 * 1024;
export const DESIGN_PARAPHRASE_PART_MAX_CHARS = 700;
export const DESIGN_META_LIST_MAX = 20;
export const DESIGN_META_SOURCES_MAX = 40;

// eslint-disable-next-line no-control-regex -- control characters are what this removes
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const BIDI_CONTROLS = /[\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}]/u;
const PLAIN_ID = /^[A-Za-z0-9._-]{1,32}$/u;

/** Model text as one safe line: secrets redacted, hidden characters removed, whitespace collapsed, cut to `max` characters. */
function oneLine(value: string, max: number): string {
  const flat = redactText(value).replace(BIDI_CONTROLS, "").replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
  const characters = Array.from(flat);
  return characters.length > max ? `${characters.slice(0, max - 1).join("")}…` : flat;
}

const PlainString = (max: number) => z.string().min(1).max(max).refine((value) => !HIDDEN_CHARACTERS.test(value), "must be plain text");
const ModelText = z.string().min(1).max(4_000);

/** The words a model can fix. They name the field and a fixed code, never the model's own text, so a hostile answer cannot write the retry prompt. */
function issueWords(error: z.ZodError): string {
  const parts = error.issues.slice(0, 3).map((issue) => {
    const where = issue.path.filter((step): step is string | number => typeof step === "string" || typeof step === "number").join(".");
    return `${where === "" ? "(block)" : where}: ${issue.code === "unrecognized_keys" ? "unknown field" : issue.code.replace(/_/gu, " ")}`;
  });
  return parts.join("; ");
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function readBlock<T>(answer: string, infoString: string, schema: z.ZodType<T>, shape: string): Parsed<T> {
  const block = lastFencedBlock(answer, infoString);
  if (block === undefined) return { ok: false, error: `Your answer has no ${infoString} block. End it with a fenced block whose info string is ${infoString}.` };
  if (block === null) return { ok: false, error: `Your ${infoString} block is not closed. End it with a line holding only three backticks.` };
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    return { ok: false, error: `The ${infoString} block is not valid JSON.` };
  }
  const result = schema.safeParse(raw);
  if (!result.success) return { ok: false, error: `The ${infoString} block does not match its shape (${shape}): ${issueWords(result.error)}.` };
  return { ok: true, value: result.data };
}

function citationsArePlain(citations: readonly DesignCitation[]): boolean {
  return citations.every((citation) => Object.values(citation).every((value) => typeof value !== "string" || !HIDDEN_CHARACTERS.test(value)));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// A reviewer's answer
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const ReviewerFindingBlockSchema = z.object({
  id: z.string().regex(PLAIN_ID),
  severity: z.enum(DESIGN_FINDING_SEVERITIES),
  section: DesignSectionSchema,
  text: ModelText,
  citations: z.array(DesignCitationSchema).min(1).max(5).refine(citationsArePlain, "citations must be plain text"),
}).strict();

const ReviewerBlockSchema = z.object({
  /** The comprehension reviewer only: what the design proposes, and how the system works today per the design. */
  paraphrase: z.object({ proposes: ModelText, today: ModelText }).strict().optional(),
  findings: z.array(ReviewerFindingBlockSchema).max(DESIGN_REVIEW_FINDINGS_PER_REVIEWER_MAX),
}).strict();

/** One finding as a reviewer reported it. `rawId` is the reviewer's id made unique across reviewers (`critic-1`). */
export interface RawDesignFinding {
  rawId: string;
  role: ReviewerRole;
  severity: DesignFinding["severity"];
  section: DesignFinding["section"];
  text: string;
  citations: DesignCitation[];
}
export type ReadDesignReview = { ok: true; role: ReviewerRole; paraphrase?: string; findings: RawDesignFinding[] } | { ok: false; error: string };

/**
 * A reviewer's findings from the last `rovara-design-review` block of its answer. Strict: a missing, unclosed or unreadable block, more than 15 findings, a finding with no
 * citation, an unknown field or a repeated id is an `error`, and the worker may ask once more. Finding text is redacted, put on one line and cut to 500 characters. The comprehension
 * reviewer must give a paraphrase; no other reviewer may, except the Light tier's Critic (`withParaphrase: true`), which must. A block with no findings is a valid answer ("I found nothing"): it is information, and lowers nothing.
 */
export function readDesignReview(answer: string, role: ReviewerRole, options: { withParaphrase?: boolean } = {}): ReadDesignReview {
  const parsed = readBlock(answer, DESIGN_REVIEW_INFO_STRING, ReviewerBlockSchema, "optional paraphrase, then findings of at most 15, each with id, severity, section, text and 1 to 5 citations");
  if (!parsed.ok) return parsed;
  const { paraphrase, findings } = parsed.value;
  // The Light tier runs one Critic "with the comprehension paraphrase" (3.4): the caller says so with `withParaphrase`. Every other role of every other tier follows its role.
  const writesParaphrase = role === "comprehension" || options.withParaphrase === true;
  if (writesParaphrase && paraphrase === undefined) return { ok: false, error: `The ${DESIGN_REVIEW_INFO_STRING} block needs a paraphrase with "proposes" and "today" before the findings.` };
  if (!writesParaphrase && paraphrase !== undefined) return { ok: false, error: `Only the comprehension reviewer writes a paraphrase; remove it from the ${DESIGN_REVIEW_INFO_STRING} block.` };
  if (new Set(findings.map((finding) => finding.id)).size !== findings.length) return { ok: false, error: `Each finding in the ${DESIGN_REVIEW_INFO_STRING} block needs its own id.` };
  const kept: RawDesignFinding[] = [];
  for (const finding of findings) {
    const text = oneLine(finding.text, DESIGN_FINDING_TEXT_MAX_CHARS);
    if (text === "") return { ok: false, error: `Finding ${finding.id} has no readable text.` };
    kept.push({ rawId: `${role}-${finding.id}`, role, severity: finding.severity, section: finding.section, text, citations: finding.citations });
  }
  let line: string | undefined;
  if (paraphrase !== undefined) {
    const proposes = oneLine(paraphrase.proposes, DESIGN_PARAPHRASE_PART_MAX_CHARS);
    const today = oneLine(paraphrase.today, DESIGN_PARAPHRASE_PART_MAX_CHARS);
    if (proposes === "" || today === "") return { ok: false, error: "The paraphrase has no readable text." };
    line = `Proposes: ${proposes} Today, per the design: ${today}`;
  }
  return { ok: true, role, ...(line === undefined ? {} : { paraphrase: line }), findings: kept };
}

/** A blocker that cites only source items must also cite the design or the code; otherwise it is shown as "source-only" and cannot be the only basis for blocking (3.12 item 5). */
export function findingRestsOnSourceAlone(finding: { citations: readonly DesignCitation[] }): boolean {
  return finding.citations.every((citation) => citation.kind === "source");
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The design's own meta block (§6 and §8)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const DESIGN_META_SOURCE_KINDS = ["repo_file", "meta_repo_file", "mcp_item"] as const;
const DesignMetaSchema = z.object({
  /** §6: why this design touches what it touches, as the same codes Understand uses. They can only raise the risk tier (3.8); leaving one out lowers nothing. */
  touches: z.array(DesignReasonSchema).max(DESIGN_REASONS.length),
  repositories: z.array(PlainString(200)).max(DESIGN_META_LIST_MAX),
  services: z.array(PlainString(200)).max(DESIGN_META_LIST_MAX),
  /** §8: the reading list for reviewers. The broker resolves each item itself (3.4); the reviewer never fetches. */
  sources: z.array(z.object({
    kind: z.enum(DESIGN_META_SOURCE_KINDS),
    ref: PlainString(500),
    repo: PlainString(200).optional(),
  }).strict()).max(DESIGN_META_SOURCES_MAX),
}).strict();
export type DesignMeta = z.infer<typeof DesignMetaSchema>;
export type ReadDesignMeta = { ok: true; meta: DesignMeta } | { ok: false; error: string };

/** The §6 and §8 data from the last `rovara-design-meta` block of the design. Strict, like the intent block: any breach is an error, and nothing is guessed. Repeats are an error. */
export function readDesignMeta(design: string): ReadDesignMeta {
  const parsed = readBlock(design, DESIGN_META_INFO_STRING, DesignMetaSchema, "touches, repositories, services and sources");
  if (!parsed.ok) return parsed;
  const meta = parsed.value;
  const sourceKeys = meta.sources.map((source) => `${source.kind}\n${source.repo ?? ""}\n${source.ref}`);
  if (new Set(meta.touches).size !== meta.touches.length || new Set(meta.repositories).size !== meta.repositories.length || new Set(meta.services).size !== meta.services.length
    || new Set(sourceKeys).size !== sourceKeys.length) return { ok: false, error: `The ${DESIGN_META_INFO_STRING} block lists something twice.` };
  return { ok: true, meta };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The merge step
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const MergeBlockSchema = z.object({
  merged: z.array(z.object({
    rawIds: z.array(z.string().min(1).max(64)).min(1).max(5 * DESIGN_REVIEW_FINDINGS_PER_REVIEWER_MAX),
    severity: z.enum(DESIGN_FINDING_SEVERITIES),
    section: DesignSectionSchema,
    text: ModelText,
  }).strict()).max(DESIGN_REVIEW_FINDINGS_MAX),
}).strict();
export interface DesignMergeDraft { rawIds: string[]; severity: DesignFinding["severity"]; section: DesignFinding["section"]; text: string }
export type ReadDesignMerge = { ok: true; merged: DesignMergeDraft[] } | { ok: false; error: string };

/** The merge model's groups from the last `rovara-design-merge` block. It has no field for a citation: it cannot add one. */
export function readDesignMerge(answer: string): ReadDesignMerge {
  const parsed = readBlock(answer, DESIGN_MERGE_INFO_STRING, MergeBlockSchema, "merged: a list of rawIds, severity, section and text");
  if (!parsed.ok) return parsed;
  const merged: DesignMergeDraft[] = [];
  for (const entry of parsed.value.merged) {
    const text = oneLine(entry.text, DESIGN_FINDING_TEXT_MAX_CHARS);
    if (text === "") return { ok: false, error: "A merged finding has no readable text." };
    merged.push({ rawIds: entry.rawIds, severity: entry.severity, section: entry.section, text });
  }
  return { ok: true, merged };
}

const SEVERITY_RANK: Record<DesignFinding["severity"], number> = { blocker: 0, major: 1, nit: 2 };
const SECTION_RANK = new Map<string, number>(DESIGN_SECTIONS.map((section, index) => [section, index]));
const ROLE_RANK = new Map<string, number>(REVIEWER_ROLES.map((role, index) => [role, index]));
const CITATION_RANK: Record<DesignCitation["kind"], number> = { design: 0, code: 1, source: 2 };


function severityOf(findings: readonly { severity: DesignFinding["severity"] }[]): DesignFinding["severity"] {
  return findings.reduce<DesignFinding["severity"]>((highest, finding) => (SEVERITY_RANK[finding.severity] < SEVERITY_RANK[highest] ? finding.severity : highest), "nit");
}

function citationKey(citation: DesignCitation): string {
  return JSON.stringify(Object.entries(citation).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
/** The raw findings' citations and no others, each once; design and code citations first, then source items, cut to the 5 a finding may hold. */
function citationUnion(group: readonly RawDesignFinding[]): DesignCitation[] {
  const seen = new Map<string, DesignCitation>();
  for (const finding of group) for (const citation of finding.citations) if (!seen.has(citationKey(citation))) seen.set(citationKey(citation), citation);
  return [...seen.values()].sort((a, b) => CITATION_RANK[a.kind] - CITATION_RANK[b.kind]).slice(0, 5);
}

function rolesOf(group: readonly RawDesignFinding[]): ReviewerRole[] {
  return [...new Set(group.map((finding) => finding.role))].sort((a, b) => (ROLE_RANK.get(a) ?? 0) - (ROLE_RANK.get(b) ?? 0));
}

function ordered<T extends { severity: DesignFinding["severity"]; section: string }>(items: T[]): T[] {
  return items.map((item, index) => ({ item, index })).sort((a, b) => SEVERITY_RANK[a.item.severity] - SEVERITY_RANK[b.item.severity]
    || (SECTION_RANK.get(a.item.section) ?? 0) - (SECTION_RANK.get(b.item.section) ?? 0) || a.index - b.index).map(({ item }) => item);
}

function buildFinding(index: number, group: readonly RawDesignFinding[], severity: DesignFinding["severity"], section: DesignFinding["section"], text: string): DesignFinding {
  // The reviewers' words are copied by code and kept; the identity comes from them (M4), so a merge text, whatever it says, cannot decide whether a finding is "the same as" an earlier one.
  const rawFindings = group.map((finding) => ({ rawId: finding.rawId, role: finding.role, severity: finding.severity, text: finding.text }));
  return {
    id: `m${index + 1}`, severity, section, text, citations: citationUnion(group), fromReviewers: rolesOf(group), rawIds: group.map((finding) => finding.rawId), rawFindings,
    fingerprint: designFindingFingerprint({ section, text, rawFindings }),
  };
}

export type DesignMergeFailure = "raw_missing" | "raw_repeated" | "raw_unknown" | "raw_duplicate" | "severity_changed" | "section_invented" | "section_mixed" | "text_not_from_raw" | "too_many";
export type DesignMergeCheck = { ok: true; findings: DesignFinding[] } | { ok: false; failure: DesignMergeFailure };

const sameRaw = (a: RawDesignFinding, b: RawDesignFinding): boolean => a.role === b.role && a.severity === b.severity && a.section === b.section && a.text === b.text && citationsKey(a.citations) === citationsKey(b.citations);
const citationsKey = (citations: readonly DesignCitation[]): string => JSON.stringify(citations.map(citationKey).sort());

/** The same raw id with different content is a bug in the caller (the same role passed twice, two reviewers sharing an id). It is never resolved by dropping one. */
function hasConflictingRaw(raw: readonly RawDesignFinding[]): boolean {
  const seen = new Map<string, RawDesignFinding>();
  for (const finding of raw) {
    const earlier = seen.get(finding.rawId);
    if (earlier !== undefined && !sameRaw(earlier, finding)) return true;
    seen.set(finding.rawId, finding);
  }
  return false;
}

/** Exact repeats of one raw finding (the same list read twice) are one finding. A repeat with different content throws: see `hasConflictingRaw`. */
function uniqueRaw(raw: readonly RawDesignFinding[]): RawDesignFinding[] {
  if (hasConflictingRaw(raw)) throw new Error("Two raw design findings share an id but differ.");
  const seen = new Set<string>();
  return raw.filter((finding) => (seen.has(finding.rawId) ? false : (seen.add(finding.rawId), true)));
}

/**
 * The merge model's groups, checked against the raw findings (3.5, 3.12 item 6). Every raw id appears in exactly one group and no group names an unknown id; a group's severity is
 * exactly the highest of its raw findings (so the model can neither soften a blocker nor raise a nit); all its raw findings share one section, which is the group's; its text is one of its
 * highest-severity raw findings' own words; its citations are taken by code from the raw findings, so none can be added. The model's free choices are the grouping and which top-severity
 * wording to show. The reviewers' words are kept on the finding (`rawFindings`), and its identity across rounds comes from them.
 */
export function checkDesignMerge(rawFindings: readonly RawDesignFinding[], merged: readonly DesignMergeDraft[]): DesignMergeCheck {
  if (hasConflictingRaw(rawFindings)) return { ok: false, failure: "raw_duplicate" };
  const raw = uniqueRaw(rawFindings);
  const byId = new Map(raw.map((finding) => [finding.rawId, finding] as const));
  if (merged.length > DESIGN_REVIEW_FINDINGS_MAX) return { ok: false, failure: "too_many" };
  const used = new Set<string>();
  const groups: Array<{ draft: DesignMergeDraft; group: RawDesignFinding[] }> = [];
  for (const draft of merged) {
    const group: RawDesignFinding[] = [];
    for (const id of draft.rawIds) {
      const finding = byId.get(id);
      if (finding === undefined) return { ok: false, failure: "raw_unknown" };
      if (used.has(id)) return { ok: false, failure: "raw_repeated" };
      used.add(id);
      group.push(finding);
    }
    if (draft.severity !== severityOf(group)) return { ok: false, failure: "severity_changed" };
    // One section per group: a severe finding cannot be filed under another section's text, and the card can show the group at its section.
    if (new Set(group.map((finding) => finding.section)).size > 1) return { ok: false, failure: "section_mixed" };
    if (group[0]!.section !== draft.section) return { ok: false, failure: "section_invented" };
    // The group's words are one of its highest-severity raw findings' words (same words, case and punctuation aside). Another finding's text, or text no reviewer wrote, is refused.
    const wording = normalizedFindingText(draft.text);
    if (!group.some((finding) => finding.severity === draft.severity && normalizedFindingText(finding.text) === wording)) return { ok: false, failure: "text_not_from_raw" };
    groups.push({ draft, group });
  }
  if (used.size !== byId.size) return { ok: false, failure: "raw_missing" };
  const findings = ordered(groups.map((entry) => ({ ...entry, severity: entry.draft.severity, section: entry.draft.section })))
    .map((entry, index) => buildFinding(index, entry.group, entry.draft.severity, entry.draft.section, entry.draft.text));
  return { ok: true, findings };
}

/**
 * The code-only merge: findings with the same section and the same words become one (highest severity, the first-found wording of that severity, the union of citations). Nothing is
 * reworded. When more than 30 remain, the lowest severities are left out and `omitted` counts the raw findings they held; blockers go last to be cut.
 */
export function mergeDesignFindingsByCode(rawFindings: readonly RawDesignFinding[]): { findings: DesignFinding[]; omitted: number } {
  const groups = new Map<string, RawDesignFinding[]>();
  for (const finding of uniqueRaw(rawFindings)) {
    const key = designFindingFingerprint(finding);
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  const drafts = ordered([...groups.values()].map((group) => {
    const severity = severityOf(group);
    const lead = group.find((finding) => finding.severity === severity) ?? group[0]!;
    return { group, severity, section: lead.section, text: lead.text };
  }));
  const kept = drafts.slice(0, DESIGN_REVIEW_FINDINGS_MAX);
  const omitted = drafts.slice(DESIGN_REVIEW_FINDINGS_MAX).reduce((total, draft) => total + draft.group.length, 0);
  return { findings: kept.map((draft, index) => buildFinding(index, draft.group, draft.severity, draft.section, draft.text)), omitted };
}

export interface DesignMergeResult {
  findings: DesignFinding[];
  omitted: number;
  /** "model" when the merge model's grouping passed every check; "code" otherwise. */
  source: "model" | "code";
  /** Why the model's merge was not used. Fixed codes only. */
  fallback?: DesignMergeFailure | "no_answer" | "unreadable";
}

/**
 * The merged findings. With no model answer (the Light tier, or a failed merge call), an unreadable one or one that fails a check, the code-only merge is used.
 * `verifiedRoles`: when given, raw findings of any other reviewer are left out BEFORE the merge (a voided reviewer's findings do not count and must not fail the round, 3.13); the count is
 * returned as `droppedUnverified`. Two raw findings that share an id but differ throw: that is a bug in the caller, never resolved by dropping one.
 */
export function mergeDesignFindings(rawFindings: readonly RawDesignFinding[], mergeAnswer?: string, options: { verifiedRoles?: ReadonlySet<ReviewerRole> } = {}): DesignMergeResult & { droppedUnverified: number } {
  const counted = options.verifiedRoles === undefined ? rawFindings : rawFindings.filter((finding) => options.verifiedRoles!.has(finding.role));
  const droppedUnverified = rawFindings.length - counted.length;
  if (hasConflictingRaw(counted)) throw new Error("Two raw design findings share an id but differ.");
  const byCode = (fallback: NonNullable<DesignMergeResult["fallback"]>): DesignMergeResult & { droppedUnverified: number } => ({ ...mergeDesignFindingsByCode(counted), source: "code", fallback, droppedUnverified });
  if (mergeAnswer === undefined) return byCode("no_answer");
  const read = readDesignMerge(mergeAnswer);
  if (!read.ok) return byCode("unreadable");
  const checked = checkDesignMerge(counted, read.merged);
  if (!checked.ok) return byCode(checked.failure);
  return { findings: checked.findings, omitted: 0, source: "model", droppedUnverified };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The planner's resolve step
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const ResolveBlockSchema = z.object({
  resolutions: z.array(z.object({
    findingId: z.string().min(1).max(64),
    action: z.enum(["fixed", "contested", "asked", "declined"]),
    note: ModelText,
    evidence: z.array(DesignCitationSchema).max(3).refine(citationsArePlain, "citations must be plain text").optional(),
    questionId: z.enum(["q1", "q2", "q3"]).optional(),
  }).strict()).max(DESIGN_REVIEW_FINDINGS_MAX),
  questions: z.array(DesignQuestionSchema).max(DESIGN_REVIEW_QUESTIONS_MAX).optional(),
}).strict();
/** A resolution as the planner wrote it. `settled` is not here: code sets it after the next round (3.12 item 4). */
export interface DesignResolutionDraft { findingId: string; action: "fixed" | "contested" | "asked" | "declined"; note: string; evidence?: DesignCitation[]; questionId?: "q1" | "q2" | "q3" }
export type ReadDesignResolve = { ok: true; resolutions: DesignResolutionDraft[]; questions: DesignQuestion[] } | { ok: false; error: string };

/**
 * The planner's answers to the findings from the last `rovara-design-resolve` block. Each finding gets exactly one answer, a "contested" one carries evidence a reviewer could read
 * (a design or code citation: a source alone cannot argue a finding away, 3.12 item 5), and an "asked" one names a question that is in the block. There is no field for a severity.
 */
export function readDesignResolve(answer: string, findingIds: readonly string[]): ReadDesignResolve {
  const parsed = readBlock(answer, DESIGN_RESOLVE_INFO_STRING, ResolveBlockSchema, "resolutions with findingId, action, note, and questions");
  if (!parsed.ok) return parsed;
  // Redacted like every other model word: a question quotes the design and the repository, which may hold a secret.
  // A question whose words are empty once cleaned is refused, never kept as the model wrote it (a whitespace-only or all-hidden string would be stored as is).
  const questions = (parsed.value.questions ?? []).map((question): DesignQuestion => ({
    ...question, unclear: oneLine(question.unclear, 200), why: oneLine(question.why, 160),
    options: question.options.map((option) => ({ ...option, label: oneLine(option.label, 80), consequence: oneLine(option.consequence, 120) })),
  }));
  if (questions.some((question) => question.unclear === "" || question.why === "" || question.options.some((option) => option.label === "" || option.consequence === ""))) return { ok: false, error: "A question has no readable text." };
  const questionIds = new Set(questions.map((question) => question.id));
  if (questionIds.size !== questions.length) return { ok: false, error: "Each question needs its own id (q1, q2, q3)." };
  const wanted = new Set(findingIds);
  const answered = new Set<string>();
  const resolutions: DesignResolutionDraft[] = [];
  for (const entry of parsed.value.resolutions) {
    if (!wanted.has(entry.findingId)) return { ok: false, error: "A resolution names a finding that was not given to you." };
    if (answered.has(entry.findingId)) return { ok: false, error: "Each finding gets exactly one resolution." };
    answered.add(entry.findingId);
    const note = oneLine(entry.note, 300);
    if (note === "") return { ok: false, error: "A resolution has no readable note." };
    const evidence = entry.evidence ?? [];
    if (entry.action === "contested" && !evidence.some((citation) => citation.kind !== "source")) return { ok: false, error: "A contested finding needs evidence that cites the design or the code." };
    if (entry.action === "asked" && (entry.questionId === undefined || !questionIds.has(entry.questionId))) return { ok: false, error: "An asked finding must name a question that is in the block." };
    if (entry.action !== "asked" && entry.questionId !== undefined) return { ok: false, error: "Only an asked finding names a question." };
    resolutions.push({ findingId: entry.findingId, action: entry.action, note, ...(evidence.length === 0 ? {} : { evidence }), ...(entry.questionId === undefined ? {} : { questionId: entry.questionId }) });
  }
  if (answered.size !== wanted.size) return { ok: false, error: "Every finding needs a resolution." };
  return { ok: true, resolutions, questions };
}
