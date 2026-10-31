// K1 lane D, D1: the spec target. Where a task's spec is written, in which format, and what the spec holds.
//
// A spec is a rendering of the owner-approved plan. The model returns a `SpecDraft` (structured, bounded, one line per statement); a deterministic renderer
// (broker/src/spec/*) turns it into the files of one format. The format is a plug-in id: this file names none of them except as the built-in ids a project may
// pick, so a new format is a new renderer, not a new contract. Everything the model wrote is untrusted text: it is cleaned to one visible line before it
// is stored or rendered, so it cannot forge a heading or a requirement line, and it carries no permission.
import { z } from "zod";
import { redactText } from "./redaction.js";

/** The formats Rovara ships a renderer for. A project's `format` is any registered id; these are the ones registered by default. */
export const BUILT_IN_SPEC_FORMATS = ["kiro", "speckit", "team_template", "rovara"] as const;
export const SPEC_WHERES = ["meta_repo", "code_repo", "pr_description"] as const;
export const SPEC_WHENS = ["always", "features", "medium_and_large", "on_request"] as const;
export const SPEC_LINK_STYLES = ["together", "spec_first"] as const;
export const SPEC_KINDS = ["feature", "bugfix"] as const;
export type SpecWhere = (typeof SPEC_WHERES)[number];
export type SpecWhen = (typeof SPEC_WHENS)[number];
export type SpecLinkStyle = (typeof SPEC_LINK_STYLES)[number];
export type SpecKind = (typeof SPEC_KINDS)[number];

export const SPEC_PATH_MAX = 200;
export const SPEC_FILE_MAX_BYTES = 64 * 1024;
export const SPEC_FILES_MAX = 12;
export const SPEC_REQUIREMENTS_MAX = 20;
export const SPEC_CRITERIA_MAX = 12;
export const SPEC_TASKS_MAX = 60;
export const SPEC_LINE_MAX = 400;
export const SPEC_DESIGN_MAX = 12_000;
export const SPEC_CHECKLIST_MAX = 7;
/** The tokens a path template may hold. */
export const SPEC_PATH_TOKENS = ["slug", "taskKey", "ticket", "n"] as const;

const HIDDEN = /[\p{Cf}\p{Cc}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

/**
 * Untrusted text as one visible line: secrets redacted, hidden and control characters (line breaks included) gone, white space collapsed, a leading list or heading marker
 * dropped, and cut to `max` characters. A line made this way cannot start a heading, a list item or a code fence in a file that holds it.
 */
export function specLine(text: string, max: number = SPEC_LINE_MAX): string {
  const plain = redactText(text).replace(/[\r\n\t\u2028\u2029]+/gu, " ").replace(HIDDEN, "").replace(/\s+/gu, " ").trim();
  // Leading markers go one after another until none is left: `- 1.1 text` is `text`.
  let bare = plain;
  for (let guard = 0; guard < 8; guard += 1) {
    const next = bare.replace(/^(?:[#>*+\-=`|~]+|\d+(?:\.\d+)+\.?|\d+[.)])\s*/u, "").trim();
    if (next === bare) break;
    bare = next;
  }
  bare = bare.replace(/`{3,}/gu, "``").trim();
  const points = Array.from(bare);
  return points.length <= max ? bare : `${points.slice(0, max - 1).join("")}…`;
}

/** Untrusted multi-line markdown (a design section) made safe to sit inside one section of a spec: hidden characters gone, every heading turned into a bold line, fences kept balanced, bounded. */
export function specMarkdown(text: string, max: number = SPEC_DESIGN_MAX): string {
  const lines = redactText(text).replace(/\r\n?/gu, "\n").replace(HIDDEN_BUT_NEWLINE, "").split("\n");
  const out: string[] = [];
  let fenced = false;
  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/u, "");
    if (/^\s{0,3}(?:`{3,}|~{3,})/u.test(line)) { fenced = !fenced; out.push(line); continue; }
    if (fenced) { out.push(line); continue; }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/u.exec(line);
    out.push(heading === null ? line : `**${(heading[1] ?? "").replace(/\s*#+\s*$/u, "").trim()}**`);
  }
  if (fenced) out.push("```");
  const joined = out.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  const points = Array.from(joined);
  return points.length <= max ? joined : `${points.slice(0, max - 1).join("")}…`;
}
const HIDDEN_BUT_NEWLINE = /(?![\n\t])[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

/** Text with hidden and control characters removed (new lines and tabs stay), line endings made `\n`. For text that is kept as written (a team's template), where `specMarkdown` would rewrite headings. */
export function specStripHidden(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replace(HIDDEN_BUT_NEWLINE, "");
}

/** The URL-safe slug of a title: lower case, letters, digits and single hyphens, at most 48 characters. Never empty. */
export function specSlug(title: string): string {
  const slug = title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48).replace(/-+$/u, "");
  return slug === "" ? "spec" : slug;
}

/**
 * Why a path (or path template) is not one a spec may be written to, or undefined. A path is relative to the repository, uses `/`, has no `.`/`..`/empty/hidden-git segment,
 * holds only letters, digits, `.`, `_`, `-` and the tokens `{slug}`, `{taskKey}`, `{ticket}`, `{n}`, and never touches `.git`. (A dot folder such as `.kiro` is fine.)
 */
export function specPathProblem(path: string, options: { tokens?: boolean } = {}): string | undefined {
  if (path.length === 0 || path.length > SPEC_PATH_MAX) return `must be 1 to ${String(SPEC_PATH_MAX)} characters`;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return "must be a relative path with / separators";
  const segments = path.replace(/\/$/u, "").split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return "must not have an empty, . or .. folder";
    if (segment.toLowerCase() === ".git" || segment.toLowerCase().startsWith(".git")) return "must not touch .git";
    const bare = options.tokens === true ? segment.replace(/\{(?:slug|taskKey|ticket|n)\}/gu, "x") : segment;
    if (!/^[A-Za-z0-9._-]+$/u.test(bare)) return "may hold only letters, digits, . _ - and the tokens {slug} {taskKey} {ticket} {n}";
  }
  return undefined;
}

const pathTemplate = z.string().superRefine((value, context) => {
  const problem = specPathProblem(value, { tokens: true });
  if (problem !== undefined) context.addIssue({ code: "custom", message: `a path template ${problem}` });
});
const folderPath = z.string().superRefine((value, context) => {
  const problem = specPathProblem(value);
  if (problem !== undefined) context.addIssue({ code: "custom", message: `a path ${problem}` });
});

/** The team's answers to the setup questions about how they write specs. Names are short keys, answers are one line. */
export const TeamChecklistAnswersSchema = z.record(z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/u), z.string().max(500))
  .refine((answers) => Object.keys(answers).length <= SPEC_CHECKLIST_MAX, `at most ${String(SPEC_CHECKLIST_MAX)} answers`);
export type TeamChecklistAnswers = z.infer<typeof TeamChecklistAnswersSchema>;

export const SpecTargetSchema = z.object({
  where: z.enum(SPEC_WHERES).default("meta_repo"),
  /** The spec's folder inside the repository it is written to. Default: the format's own. */
  pathTemplate: pathTemplate.optional(),
  /** A registered format id; an unknown one is refused when a spec is due, never guessed. */
  format: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u).default("kiro"),
  /** `team_template`: a folder in the meta repo with one file per section, read at the task's `knowledgeCommit`. */
  templatePath: folderPath.optional(),
  when: z.enum(SPEC_WHENS).default("features"),
  linkStyle: z.enum(SPEC_LINK_STYLES).default("together"),
  checklist: TeamChecklistAnswersSchema.optional(),
}).strict().superRefine((target, context) => {
  if (target.format === "team_template" && target.templatePath === undefined) context.addIssue({ code: "custom", path: ["templatePath"], message: "the team template format needs the folder that holds the template" });
  if (target.templatePath !== undefined && target.format !== "team_template") context.addIssue({ code: "custom", path: ["templatePath"], message: "only the team template format reads a template folder" });
  if (target.where === "pr_description" && target.linkStyle === "spec_first") context.addIssue({ code: "custom", path: ["linkStyle"], message: "a spec in the pull request description has no pull request of its own to wait for" });
});
export type SpecTarget = z.infer<typeof SpecTargetSchema>;

/** The spec target a project has when it names none: nothing is written (`when` "on_request" is the only way to ask, and only the owner can). */
export function defaultSpecTarget(): SpecTarget {
  return SpecTargetSchema.parse({});
}

// ---------------------------------------------------------------------------------------------------------------------
// The draft the SPEC_WRITE operation returns, and the files a renderer makes from it.
// ---------------------------------------------------------------------------------------------------------------------

const Line = z.string().transform((value) => specLine(value)).pipe(z.string().min(1).max(SPEC_LINE_MAX));
const OptionalLine = z.string().transform((value) => specLine(value)).pipe(z.string().max(SPEC_LINE_MAX)).transform((value) => (value === "" ? undefined : value));

/** One EARS statement: `WHEN <when> THE SYSTEM SHALL <shall>`; without `when`, `THE SYSTEM SHALL <shall>`. The words WHEN and SHALL are added by the renderer. */
export const SpecCriterionSchema = z.object({
  when: OptionalLine.optional(),
  shall: Line,
}).strict();
export type SpecCriterion = z.infer<typeof SpecCriterionSchema>;

export const SpecRequirementSchema = z.object({
  title: Line,
  userStory: OptionalLine.optional(),
  criteria: z.array(SpecCriterionSchema).min(1).max(SPEC_CRITERIA_MAX),
}).strict();
export type SpecRequirement = z.infer<typeof SpecRequirementSchema>;

export const SpecBugfixSchema = z.object({
  /** The defect: what happens now. `shall` holds the faulty behaviour in the words of an observation, not a promise. */
  current: z.array(SpecCriterionSchema).min(1).max(SPEC_CRITERIA_MAX),
  expected: z.array(SpecCriterionSchema).min(1).max(SPEC_CRITERIA_MAX),
  unchanged: z.array(SpecCriterionSchema).max(SPEC_CRITERIA_MAX),
}).strict();
export type SpecBugfix = z.infer<typeof SpecBugfixSchema>;

export const SpecTaskSchema = z.object({
  title: Line,
  /** Requirement labels this step covers, as `SpecRequirementRef.id` gives them (`1.2`). Unknown labels are dropped when rendered. */
  covers: z.array(z.string().regex(/^[0-9]{1,2}\.[0-9]{1,2}$/u)).max(SPEC_CRITERIA_MAX).default([]),
}).strict();
export type SpecTask = z.infer<typeof SpecTaskSchema>;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const SpecDraftSchema = z.object({
  version: z.literal(1),
  kind: z.enum(SPEC_KINDS),
  title: Line,
  summary: z.string().transform((value) => specLine(value, 1_500)).pipe(z.string().max(1_500)),
  requirements: z.array(SpecRequirementSchema).max(SPEC_REQUIREMENTS_MAX).default([]),
  bugfix: SpecBugfixSchema.optional(),
  design: z.string().transform((value) => specMarkdown(value)).pipe(z.string().max(SPEC_DESIGN_MAX)).default(""),
  tasks: z.array(SpecTaskSchema).max(SPEC_TASKS_MAX).default([]),
  /** The digest of the approved plan this draft was written from. The broker refuses a draft whose digest is not the approved plan's. */
  planDigest: Sha256,
}).strict().superRefine((draft, context) => {
  if (draft.kind === "feature" && (draft.requirements.length === 0 || draft.bugfix !== undefined)) context.addIssue({ code: "custom", path: ["requirements"], message: "a feature spec has requirements and no bugfix section" });
  if (draft.kind === "bugfix" && (draft.bugfix === undefined || draft.requirements.length > 0)) context.addIssue({ code: "custom", path: ["bugfix"], message: "a bugfix spec has a bugfix section and no feature requirements" });
});
export type SpecDraft = z.infer<typeof SpecDraftSchema>;

export const SpecFileSchema = z.object({
  /** Relative to the repository root. */
  path: folderPath,
  content: z.string().max(SPEC_FILE_MAX_BYTES),
}).strict().refine((file) => new TextEncoder().encode(file.content).byteLength <= SPEC_FILE_MAX_BYTES, "a spec file is at most 64 KiB");
export type SpecFile = z.infer<typeof SpecFileSchema>;

/** One checkable statement of a spec. `id` is the label as the spec shows it (`1.2`, `FR-001`); review answers by it, and W4's requirement-to-evidence table keys on `(specPath, id)`. */
export const SpecRequirementRefSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,23}$/u),
  text: z.string().min(1).max(SPEC_LINE_MAX + 40),
  /** "defect" lines (a bug's current behaviour) describe the fault and are not checked against the code. */
  kind: z.enum(["requirement", "defect"]),
  /** The file the statement is in. */
  path: folderPath,
}).strict();
export type SpecRequirementRef = z.infer<typeof SpecRequirementRefSchema>;

/** The most requirements one review walks. A spec with more is walked up to this many and said so. */
export const SPEC_REVIEW_REQUIREMENTS_MAX = 80;

/**
 * The EARS words for one criterion. A `when` that already starts with WHEN, and a `shall` that already starts with THE SYSTEM SHALL, are not doubled.
 * `verb: "observed"` writes a defect (what the system does now) without a promise: `WHEN <when> THE SYSTEM <what happens>`.
 */
export function earsLine(criterion: SpecCriterion, options: { verb?: "SHALL" | "SHALL CONTINUE TO" | "observed" } = {}): string {
  const verb = options.verb ?? "SHALL";
  const when = criterion.when === undefined ? undefined : criterion.when.replace(/^when\s+/iu, "").trim();
  const prefix = when === undefined || when === "" ? "" : `WHEN ${when} `;
  if (verb === "observed") return `${prefix}THE SYSTEM ${criterion.shall.replace(/^the system\s+/iu, "").trim()}`;
  const shall = criterion.shall.replace(/^(?:the system\s+)?shall(?:\s+continue\s+to)?\s+/iu, "").trim();
  return `${prefix}THE SYSTEM ${verb} ${shall}`;
}

/** The requirement labels a draft has, in order, as the format-independent `n.m` numbers (a bug's three sections are 1.x defect, 2.x expected, 3.x unchanged, as Kiro numbers them). */
export function specDraftStatements(draft: SpecDraft): Array<{ id: string; text: string; kind: "requirement" | "defect" }> {
  if (draft.kind === "bugfix" && draft.bugfix !== undefined) {
    return [
      ...draft.bugfix.current.map((criterion, index) => ({ id: `1.${String(index + 1)}`, text: earsLine(criterion, { verb: "observed" }), kind: "defect" as const })),
      ...draft.bugfix.expected.map((criterion, index) => ({ id: `2.${String(index + 1)}`, text: earsLine(criterion), kind: "requirement" as const })),
      ...draft.bugfix.unchanged.map((criterion, index) => ({ id: `3.${String(index + 1)}`, text: earsLine(criterion, { verb: "SHALL CONTINUE TO" }), kind: "requirement" as const })),
    ];
  }
  return draft.requirements.flatMap((requirement, requirementIndex) => requirement.criteria.map((criterion, index) => ({
    id: `${String(requirementIndex + 1)}.${String(index + 1)}`, text: earsLine(criterion), kind: "requirement" as const,
  })));
}

// ---------------------------------------------------------------------------------------------------------------------
// What a review says about a spec (D3).
// ---------------------------------------------------------------------------------------------------------------------

export const SPEC_VERDICTS = ["met", "not_met", "not_applicable"] as const;
export type SpecVerdict = (typeof SPEC_VERDICTS)[number];

/** One requirement's verdict, as the review reports it and W4's requirement-to-evidence table reads it. `evidence` names code (diff lines or a test) the verdict rests on; it is text, never a command. */
export const SpecRequirementVerdictSchema = z.object({
  id: SpecRequirementRefSchema.shape.id,
  verdict: z.enum(SPEC_VERDICTS),
  /** Why, in one line. For not_met this is the finding; for not_applicable it is the reason; for met it names the evidence. */
  reason: Line,
  evidence: z.array(Line).max(6).default([]),
}).strict();
export type SpecRequirementVerdict = z.infer<typeof SpecRequirementVerdictSchema>;

/** The review's walk of one spec: the commit it was read at, and one verdict per requirement the review was given. */
export const SpecReviewResultSchema = z.object({
  specPath: folderPath,
  specCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  verdicts: z.array(SpecRequirementVerdictSchema).max(SPEC_REVIEW_REQUIREMENTS_MAX),
  /** Requirements the review was given but did not answer. Each counts as not met. */
  unanswered: z.array(SpecRequirementRefSchema.shape.id).max(SPEC_REVIEW_REQUIREMENTS_MAX).default([]),
  /** The spec had more requirements than the walk takes. */
  truncated: z.boolean().default(false),
}).strict();
export type SpecReviewResult = z.infer<typeof SpecReviewResultSchema>;
