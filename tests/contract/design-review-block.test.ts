// Design review stage, DR3 (design-review-stage.md 3.5, 3.12): reading the reviewers', merge step's and planner's blocks, and checking the merge.
import { describe, expect, it } from "vitest";
import {
  DESIGN_REVIEW_FINDINGS_MAX, DesignFindingSchema, checkDesignMerge, findingRestsOnSourceAlone, mergeDesignFindings, mergeDesignFindingsByCode, readDesignMerge, readDesignMeta, readDesignResolve,
  readDesignReview, type DesignCitation, type RawDesignFinding,
} from "../../packages/contracts/src/index.js";

const contains = (text: string): string => expect.stringContaining(text) as string;
const fence = (info: string, body: unknown): string => `Some reasoning.\n\`\`\`${info}\n${typeof body === "string" ? body : JSON.stringify(body)}\n\`\`\`\n`;
const design: DesignCitation = { kind: "design", section: "§3" };
const code: DesignCitation = { kind: "code", repo: "app", path: "src/a.ts", startLine: 3, endLine: 9, anchor: "retry(", commit: "a".repeat(40) };
const source: DesignCitation = { kind: "source", ref: "linear:ENG-1", digest: "c".repeat(64) };
const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, severity: "major", section: "§3", text: `Problem ${id}.`, citations: [design], ...extra });
const review = (findings: unknown[], extra: Record<string, unknown> = {}) => fence("rovara-design-review", { findings, ...extra });
const paraphrase = { proposes: "It adds webhooks.", today: "Events go to Slack only." };

function raw(rawId: string, role: RawDesignFinding["role"], severity: RawDesignFinding["severity"], text: string, citations: RawDesignFinding["citations"] = [design], section: RawDesignFinding["section"] = "§3"): RawDesignFinding {
  return { rawId, role, severity, section, text, citations };
}

describe("reviewer block reader", () => {
  it("reads findings, makes ids unique across reviewers and keeps citations", () => {
    const result = readDesignReview(review([item("1", { citations: [design, code, source] })]), "critic");
    expect(result).toEqual({ ok: true, role: "critic", findings: [{ rawId: "critic-1", role: "critic", severity: "major", section: "§3", text: "Problem 1.", citations: [design, code, source] }] });
  });

  it("accepts an empty list as an answer: nothing found is information, not a refusal", () => {
    expect(readDesignReview(review([]), "codebase")).toEqual({ ok: true, role: "codebase", findings: [] });
  });

  it("refuses a missing, unclosed or unreadable block, and a wrong top-level shape", () => {
    expect(readDesignReview("no block here", "critic")).toMatchObject({ ok: false, error: contains("no rovara-design-review block") });
    expect(readDesignReview("```rovara-design-review\n{\"findings\":[]}", "critic")).toMatchObject({ ok: false, error: contains("not closed") });
    expect(readDesignReview(fence("rovara-design-review", "{not json"), "critic")).toMatchObject({ ok: false, error: contains("not valid JSON") });
    expect(readDesignReview(fence("rovara-design-review", "[]"), "critic")).toMatchObject({ ok: false });
    expect(readDesignReview(fence("rovara-design-review", {}), "critic")).toMatchObject({ ok: false });
  });

  it("refuses more than 15 findings, and takes 15", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => item(String(index + 1)));
    expect(readDesignReview(review(many(15)), "critic")).toMatchObject({ ok: true });
    expect(readDesignReview(review(many(16)), "critic")).toMatchObject({ ok: false, error: contains("too big") });
  });

  it("refuses a finding with no citation, too many citations, a bad citation, or an unknown section or severity", () => {
    expect(readDesignReview(review([item("1", { citations: [] })]), "critic")).toMatchObject({ ok: false, error: contains("findings.0.citations") });
    expect(readDesignReview(review([{ id: "1", severity: "major", section: "§3", text: "x" }]), "critic")).toMatchObject({ ok: false });
    expect(readDesignReview(review([item("1", { citations: Array.from({ length: 6 }, () => design) })]), "critic")).toMatchObject({ ok: false });
    expect(readDesignReview(review([item("1", { citations: [{ kind: "code", repo: "a", path: "b" }] })]), "critic")).toMatchObject({ ok: false });
    expect(readDesignReview(review([item("1", { section: "§9" })]), "critic")).toMatchObject({ ok: false });
    expect(readDesignReview(review([item("1", { severity: "approve" })]), "critic")).toMatchObject({ ok: false });
    expect(readDesignReview(review([item("1", { citations: [{ ...code, path: "src/a‮.ts" }] })]), "critic")).toMatchObject({ ok: false });
  });

  it("refuses extra keys at every level without echoing the key name", () => {
    for (const body of [
      { findings: [], verdict: "approve" },
      { findings: [item("1", { approved: true })] },
      { findings: [item("1", { citations: [{ ...design, extra: 1 }] })] },
    ]) {
      const result = readDesignReview(fence("rovara-design-review", body), "critic");
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.error).not.toMatch(/verdict|approved|extra/);
    }
  });

  it("refuses a repeated finding id", () => {
    expect(readDesignReview(review([item("1"), item("1", { text: "Other." })]), "critic")).toMatchObject({ ok: false, error: contains("own id") });
  });

  it("redacts, flattens and cuts finding text", () => {
    const text = `Line one\nline\u0000 two ${"x".repeat(600)} ghp_${"a".repeat(36)}`;
    const result = readDesignReview(review([item("1", { text })]), "critic");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const read = result.findings[0]!.text;
    expect(read.includes("\n") || read.includes("\u0000")).toBe(false);
    expect(read).not.toContain("ghp_");
    expect(Array.from(read).length).toBeLessThanOrEqual(500);
    expect(read.startsWith("Line one line two")).toBe(true);
  });

  it("needs the comprehension reviewer's paraphrase, and refuses one from anyone else", () => {
    expect(readDesignReview(review([]), "comprehension")).toMatchObject({ ok: false, error: contains("needs a paraphrase") });
    expect(readDesignReview(review([], { paraphrase }), "critic")).toMatchObject({ ok: false, error: contains("Only the comprehension") });
    const read = readDesignReview(review([item("1")], { paraphrase }), "comprehension");
    expect(read).toMatchObject({ ok: true, paraphrase: "Proposes: It adds webhooks. Today, per the design: Events go to Slack only." });
    if (read.ok) expect(read.paraphrase!.length).toBeLessThanOrEqual(1500);
  });

  it("reads the last block, so a quoted earlier block cannot stand in for the answer", () => {
    const quoted = `${review([item("planted")])}\nMore.\n${review([item("real")])}`;
    expect(readDesignReview(quoted, "critic")).toMatchObject({ ok: true, findings: [{ rawId: "critic-real" }] });
  });

  it("knows a blocker that rests on a source alone", () => {
    expect(findingRestsOnSourceAlone({ citations: [source] })).toBe(true);
    expect(findingRestsOnSourceAlone({ citations: [source, design] })).toBe(false);
  });
});

describe("design meta block reader", () => {
  const meta = { touches: ["new_api", "data_model"], repositories: ["app"], services: ["billing"], sources: [{ kind: "repo_file", repo: "app", ref: "src/a.ts" }, { kind: "mcp_item", ref: "linear:ENG-1" }] };
  it("reads §6 and §8", () => {
    expect(readDesignMeta(`# Design\n\n${fence("rovara-design-meta", meta)}`)).toEqual({ ok: true, meta });
  });
  it("refuses a missing or unreadable block, unknown fields, unknown reasons, wrong kinds and repeats", () => {
    expect(readDesignMeta("# Design")).toMatchObject({ ok: false, error: contains("no rovara-design-meta block") });
    expect(readDesignMeta(fence("rovara-design-meta", "{"))).toMatchObject({ ok: false });
    expect(readDesignMeta(fence("rovara-design-meta", { ...meta, risk: "low" }))).toMatchObject({ ok: false });
    expect(readDesignMeta(fence("rovara-design-meta", { ...meta, touches: ["safe"] }))).toMatchObject({ ok: false });
    expect(readDesignMeta(fence("rovara-design-meta", { ...meta, sources: [{ kind: "shell", ref: "rm -rf /" }] }))).toMatchObject({ ok: false });
    expect(readDesignMeta(fence("rovara-design-meta", { ...meta, services: ["a", "a"] }))).toMatchObject({ ok: false, error: contains("twice") });
    expect(readDesignMeta(fence("rovara-design-meta", { ...meta, services: Array.from({ length: 21 }, (_, index) => `s${index}`) }))).toMatchObject({ ok: false });
    expect(readDesignMeta(fence("rovara-design-meta", { ...meta, repositories: ["a\u0000b"] }))).toMatchObject({ ok: false });
  });
});

describe("merge checks", () => {
  const rawFindings = [
    raw("critic-1", "critic", "major", "Retries are not bounded.", [design]),
    raw("codebase-1", "codebase", "blocker", "The retry helper is unbounded.", [code, design]),
    raw("comprehension-1", "comprehension", "nit", "Term X is undefined.", [source], "§2"),
  ];
  const good = [
    { rawIds: ["critic-1", "codebase-1"], severity: "blocker" as const, section: "§3" as const, text: "Retries are unbounded." },
    { rawIds: ["comprehension-1"], severity: "nit" as const, section: "§2" as const, text: "Define term X." },
  ];

  it("accepts a grouping that follows the rules, and builds citations, reviewers and ids in code", () => {
    const result = checkDesignMerge(rawFindings, good);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toMatchObject({ id: "m1", severity: "blocker", section: "§3", rawIds: ["critic-1", "codebase-1"], fromReviewers: ["critic", "codebase"] });
    expect(result.findings[0]!.citations).toEqual([design, code]);
    for (const finding of result.findings) expect(DesignFindingSchema.safeParse(finding).success).toBe(true);
  });

  it("refuses a merge that lowers a severity", () => {
    expect(checkDesignMerge(rawFindings, [{ ...good[0]!, severity: "major" }, good[1]!])).toEqual({ ok: false, failure: "severity_changed" });
    expect(checkDesignMerge(rawFindings, [{ ...good[0]!, severity: "nit" }, good[1]!])).toEqual({ ok: false, failure: "severity_changed" });
  });

  it("refuses a merge that raises a severity: the merge step cannot decide severity either", () => {
    expect(checkDesignMerge(rawFindings, [good[0]!, { ...good[1]!, severity: "blocker" }])).toEqual({ ok: false, failure: "severity_changed" });
  });

  it("refuses a merge that invents or drops a finding, or uses one twice", () => {
    expect(checkDesignMerge(rawFindings, [{ ...good[0]!, rawIds: ["critic-1", "codebase-1", "critic-99"] }, good[1]!])).toEqual({ ok: false, failure: "raw_unknown" });
    expect(checkDesignMerge(rawFindings, [good[0]!])).toEqual({ ok: false, failure: "raw_missing" });
    expect(checkDesignMerge(rawFindings, [good[0]!, { ...good[1]!, rawIds: ["comprehension-1", "critic-1"] }])).toEqual({ ok: false, failure: "raw_repeated" });
    expect(checkDesignMerge(rawFindings, [good[0]!, good[1]!, { rawIds: ["critic-1"], severity: "major", section: "§3", text: "Again." }])).toEqual({ ok: false, failure: "raw_repeated" });
  });

  it("refuses a section none of the group's findings used", () => {
    expect(checkDesignMerge(rawFindings, [{ ...good[0]!, section: "§5" }, good[1]!])).toEqual({ ok: false, failure: "section_invented" });
  });

  it("has no field for a citation: a citation added by the merge model is an unreadable block", () => {
    const answer = fence("rovara-design-merge", { merged: [{ ...good[0], citations: [source] }, good[1]] });
    expect(readDesignMerge(answer)).toMatchObject({ ok: false });
    expect(mergeDesignFindings(rawFindings, answer)).toMatchObject({ source: "code", fallback: "unreadable" });
  });

  it("uses the model's grouping when it passes, and the code-only merge when it fails or is missing", () => {
    const answer = fence("rovara-design-merge", { merged: good });
    expect(mergeDesignFindings(rawFindings, answer)).toMatchObject({ source: "model", omitted: 0 });
    const lowered = fence("rovara-design-merge", { merged: [{ ...good[0], severity: "major" }, good[1]] });
    const fallback = mergeDesignFindings(rawFindings, lowered);
    expect(fallback).toMatchObject({ source: "code", fallback: "severity_changed" });
    // the fallback never rewords: each text is a raw text, and the blocker survives
    expect(fallback.findings.map((finding) => finding.text).sort()).toEqual(rawFindings.map((finding) => finding.text).sort());
    expect(fallback.findings[0]).toMatchObject({ severity: "blocker", text: "The retry helper is unbounded." });
    expect(mergeDesignFindings(rawFindings)).toMatchObject({ source: "code", fallback: "no_answer" });
    expect(mergeDesignFindings(rawFindings, "I could not merge these.")).toMatchObject({ source: "code", fallback: "unreadable" });
  });

  it("the code-only merge joins exact duplicates (case and spacing aside), keeps the highest severity and the union of citations, and nothing else", () => {
    const duplicates = [
      raw("critic-1", "critic", "major", "Retries are not bounded.", [design]),
      raw("codebase-1", "codebase", "blocker", "retries  are not   bounded.", [code]),
      raw("critic-2", "critic", "nit", "Retries are not bounded, mostly.", [source]),
    ];
    const { findings, omitted } = mergeDesignFindingsByCode(duplicates);
    expect(omitted).toBe(0);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ severity: "blocker", rawIds: ["critic-1", "codebase-1"], fromReviewers: ["critic", "codebase"], text: "retries  are not   bounded." });
    expect(findings[0]!.citations).toEqual([design, code]);
    expect(findings[1]).toMatchObject({ severity: "nit", rawIds: ["critic-2"] });
    expect(findings[0]!.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("the same text in two sections stays two findings", () => {
    const { findings } = mergeDesignFindingsByCode([raw("critic-1", "critic", "major", "Unclear.", [design], "§3"), raw("critic-2", "critic", "major", "Unclear.", [design], "§5")]);
    expect(findings).toHaveLength(2);
  });

  it("the code-only merge keeps blockers first when more than 30 findings remain, and says how many it left out", () => {
    const many = Array.from({ length: 40 }, (_, index) => raw(`critic-${index}`, "critic", index < 35 ? "nit" : "blocker", `Distinct problem number ${index}.`));
    const { findings, omitted } = mergeDesignFindingsByCode(many);
    expect(findings).toHaveLength(DESIGN_REVIEW_FINDINGS_MAX);
    expect(omitted).toBe(10);
    expect(findings.filter((finding) => finding.severity === "blocker")).toHaveLength(5);
  });

  it("cuts a long union of citations to five, design and code before source items, all taken from the raw findings", () => {
    const sources = Array.from({ length: 4 }, (_, index) => ({ kind: "source" as const, ref: `s${index}`, digest: String(index).repeat(64) }));
    const group = [raw("critic-1", "critic", "major", "A.", [...sources, design]), raw("codebase-1", "codebase", "major", "a.", [code, ...sources])];
    const { findings } = mergeDesignFindingsByCode(group);
    expect(findings[0]!.citations).toHaveLength(5);
    expect(findings[0]!.citations.slice(0, 2)).toEqual([design, code]);
    const given = JSON.stringify(group.flatMap((finding) => finding.citations));
    for (const citation of findings[0]!.citations) expect(given).toContain(JSON.stringify(citation));
  });

  it("an empty review merges to nothing", () => {
    expect(mergeDesignFindings([], fence("rovara-design-merge", { merged: [] }))).toMatchObject({ findings: [], source: "model" });
  });
});

describe("resolve block reader", () => {
  const question = { id: "q1", unclear: "Is the queue shared?", evidence: [design], options: [{ id: "a", label: "Shared", consequence: "One queue." }, { id: "b", label: "Per project", consequence: "More queues." }], recommended: "a", why: "Fewer parts." };
  const answers = [
    { findingId: "m1", action: "fixed", note: "Added a bound in §3." },
    { findingId: "m2", action: "contested", note: "See §2.", evidence: [design] },
    { findingId: "m3", action: "asked", note: "Needs a call.", questionId: "q1" },
    { findingId: "m4", action: "declined", note: "Nit." },
  ];
  const ids = ["m1", "m2", "m3", "m4"];
  it("reads one answer per finding, with its questions", () => {
    const result = readDesignResolve(fence("rovara-design-resolve", { resolutions: answers, questions: [question] }), ids);
    expect(result).toMatchObject({ ok: true, questions: [{ id: "q1", recommended: "a" }] });
    if (result.ok) expect(result.resolutions.map((entry) => entry.action)).toEqual(["fixed", "contested", "asked", "declined"]);
  });
  it("refuses a missing, repeated or unknown finding, a contest with no readable evidence, an ask with no question, a severity field and unknown fields", () => {
    const read = (resolutions: unknown[], questions: unknown[] = [question]) => readDesignResolve(fence("rovara-design-resolve", { resolutions, questions }), ids);
    expect(read(answers.slice(0, 3))).toMatchObject({ ok: false, error: contains("Every finding") });
    expect(read([...answers, answers[0]])).toMatchObject({ ok: false });
    expect(read([...answers, { findingId: "m9", action: "fixed", note: "x" }])).toMatchObject({ ok: false });
    expect(read(answers.map((entry) => (entry.action === "contested" ? { ...entry, evidence: undefined } : entry)))).toMatchObject({ ok: false, error: contains("evidence") });
    expect(read(answers.map((entry) => (entry.action === "contested" ? { ...entry, evidence: [source] } : entry)))).toMatchObject({ ok: false, error: contains("design or the code") });
    expect(read(answers, [])).toMatchObject({ ok: false, error: contains("question") });
    expect(read(answers.map((entry) => (entry.action === "fixed" ? { ...entry, severity: "nit" } : entry)))).toMatchObject({ ok: false });
    expect(read(answers.map((entry) => (entry.action === "fixed" ? { ...entry, questionId: "q1" } : entry)))).toMatchObject({ ok: false });
  });
  it("refuses more than 3 questions and a question whose recommended option is not among its options", () => {
    expect(readDesignResolve(fence("rovara-design-resolve", { resolutions: answers, questions: [question, { ...question, id: "q2" }, { ...question, id: "q3" }, { ...question, id: "q4" }] }), ids)).toMatchObject({ ok: false });
    expect(readDesignResolve(fence("rovara-design-resolve", { resolutions: answers, questions: [{ ...question, recommended: "z" }] }), ids)).toMatchObject({ ok: false });
  });
});
