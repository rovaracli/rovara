// Proof and evidence P1: the EvidencePack contract (bounds, strictness, cross-field rules), its view with artifact links, the check kind on checks, retention and the evidence mode.
import { describe, expect, it } from "vitest";
import { CheckClassSchema, CheckEntrySchema, CheckOutcomeSchema } from "../../packages/contracts/src/checks.js";
import { DeveloperTaskViewReaderSchema } from "../../packages/contracts/src/session-views.js";
import { DeveloperTaskViewSchema } from "../../packages/contracts/src/developer-tasks.js";
import { ProofTableViewSchema } from "../../packages/contracts/src/rovara-code.js";
import { WorkflowCheckSchema } from "../../packages/contracts/src/task-workflow.js";
import * as evidence from "../../packages/contracts/src/evidence.js";
import { taskViewForClient } from "../../packages/broker/src/rovara-code/task-view-compat.js";

const sha = (letter: string) => letter.repeat(64);
const ref = (kind: evidence.EvidenceArtifactKind, letter = "a", bytes = 1_000): evidence.ArtifactRef => ({ kind, sha256: sha(letter), bytes, retentionClass: evidence.EVIDENCE_ARTIFACT_RETENTION[kind] });
const link = (kind: evidence.EvidenceArtifactKind, letter = "a"): evidence.ArtifactLink => ({ ...ref(kind, letter), state: "available", href: `/v1/app/tasks/t1/evidence/${sha(letter)}` });
const check = (overrides: Record<string, unknown> = {}) => ({
  checkId: "readiness:0", kind: "test", label: "pytest", before: "failed", after: "passed", class: "fixed", durationMs: 1200,
  tests: { total: 4, passed: 2, failed: 0, skipped: 1, errored: 1, names: [{ name: "test_match.py::test_no_region", status: "passed", proof: "proves_change" }], newTests: ["test_match.py::test_no_region"] },
  ...overrides,
});
const pack = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, candidateDigest: sha("c"),
  environment: { tier: "sandbox", envRevision: 3, services: [{ name: "partner-scorer", mode: "mocked", fixtureRevision: 2, schemaVersion: 3, recordedAt: "2026-11-02T00:00:00.000Z" }], data: "synthetic", accounts: [{ profileId: "buyer", kind: "run_scoped" }] },
  checks: [check()],
  selection: { method: "coverage_map", selected: 37, total: 1240, mapAgeHours: 14, lastFullRun: { at: "2026-11-04T02:10:00.000Z", status: "passed", passed: 1238, total: 1240, flaky: 2 } },
  api: [{ scenarioId: "rank-top5", samples: [ref("api_sample_json")], diff: "none", changedPaths: [] }],
  browser: [{ scenarioId: "login", strip: { before: [ref("jpeg", "b")], after: [ref("jpeg", "d")] }, video: ref("webm", "e"), consoleErrors: 0 }],
  notTested: [{ kind: "mocked_service", id: "partner-scorer", text: "SageMaker timeout", reason: "mock cannot produce it" }],
  ...overrides,
});
const view = (overrides: Record<string, unknown> = {}) => pack({ api: [{ scenarioId: "rank-top5", samples: [link("api_sample_json")], diff: "none", changedPaths: [] }], browser: [{ scenarioId: "login", strip: { before: [link("jpeg", "b")], after: [link("jpeg", "d")] }, video: link("webm", "e"), consoleErrors: 0 }], ...overrides });

describe("EvidencePack", () => {
  it("accepts a full pack and round-trips it unchanged", () => {
    expect(evidence.EvidencePackSchema.parse(pack())).toEqual(pack());
  });
  it("is strict at every level: an unknown field is refused", () => {
    for (const bad of [pack({ extra: 1 }), pack({ environment: { ...pack().environment, extra: 1 } }), pack({ checks: [check({ extra: 1 })] }), pack({ selection: { ...pack().selection, extra: 1 } })]) expect(evidence.EvidencePackSchema.safeParse(bad).success).toBe(false);
  });
  it("is for synthetic data only and a candidate digest in lower-case hex", () => {
    expect(evidence.EvidencePackSchema.safeParse(pack({ environment: { ...pack().environment, data: "production" } })).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(pack({ candidateDigest: "C".repeat(64) })).success).toBe(false);
    expect(evidence.evidenceIsFor(pack() as evidence.EvidencePack, sha("c"))).toBe(true);
    expect(evidence.evidenceIsFor(pack() as evidence.EvidencePack, sha("d"))).toBe(false);
    expect(evidence.evidenceIsFor(undefined, sha("c"))).toBe(false);
  });
  it("refuses texts with control or format characters (a newline, an escape, a bidirectional override)", () => {
    for (const label of ["two\nlines", "esc\u001b[31m", "flip‮gnp.exe", "zero​width"]) {
      expect(evidence.EvidencePackSchema.safeParse(pack({ checks: [check({ label })] })).success, JSON.stringify(label)).toBe(false);
    }
  });
  it("bounds every list at the design's limits", () => {
    const names = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `t${String(index)}`, status: "passed" as const }));
    const withNames = (count: number, extra = {}) => pack({ checks: [check({ tests: { total: count, passed: count, failed: 0, skipped: 0, errored: 0, names: names(count), newTests: [], ...extra } })] });
    expect(evidence.EvidencePackSchema.safeParse(withNames(500)).success).toBe(true);
    expect(evidence.EvidencePackSchema.safeParse(withNames(501)).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(withNames(1, { newTests: Array.from({ length: 101 }, (_, index) => `n${String(index)}`) })).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(pack({ api: [{ scenarioId: "a", samples: Array.from({ length: 6 }, () => ref("api_sample_json")), diff: "none", changedPaths: [] }] })).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(pack({ browser: [{ scenarioId: "a", strip: { before: Array.from({ length: 7 }, () => ref("jpeg")), after: [] }, consoleErrors: 0 }] })).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(pack({ checks: Array.from({ length: 65 }, (_, index) => check({ checkId: `c${String(index)}`, tests: undefined })) })).success).toBe(false);
  });
  it("bounds the test names of a whole pack at 2,000", () => {
    const big = (id: string) => check({ checkId: id, tests: { total: 500, passed: 500, failed: 0, skipped: 0, errored: 0, names: Array.from({ length: 500 }, (_, index) => ({ name: `t${String(index)}`, status: "passed" })), newTests: [] } });
    expect(evidence.EvidencePackSchema.safeParse(pack({ checks: [big("a"), big("b"), big("c"), big("d")] })).success).toBe(true);
    expect(evidence.EvidencePackSchema.safeParse(pack({ checks: [big("a"), big("b"), big("c"), big("d"), big("e")] })).success).toBe(false);
  });
  it("keeps counts honest: totals add up, covered lines are some of the changed lines, severities add up, selected is some of the total", () => {
    expect(evidence.EvidencePackSchema.safeParse(pack({ checks: [check({ tests: { ...check().tests, total: 5 } })] })).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(pack({ checks: [check({ coverage: { linesChanged: 48, linesCovered: 49, files: [] } })] })).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(pack({ checks: [check({ coverage: { linesChanged: 48, linesCovered: 41, files: [{ path: "a.py", uncovered: [3, 4] }] } })] })).success).toBe(true);
    const findings = (newCount: number) => check({ kind: "security", tests: undefined, findings: { tool: "bandit", newCount, bySeverity: { critical: 0, high: 1, medium: 1, low: 0, info: 0 }, items: [] } });
    expect(evidence.EvidencePackSchema.safeParse(pack({ checks: [findings(2)] })).success).toBe(true);
    expect(evidence.EvidencePackSchema.safeParse(pack({ checks: [findings(1)] })).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(pack({ selection: { method: "full", selected: 11, total: 10 } })).success).toBe(false);
  });
  it("takes the skips among untouched tests as a pair that is some of the skips", () => {
    const tests = (extra: Record<string, unknown>) => pack({ checks: [check({ tests: { ...check().tests, ...extra } })] });
    expect(evidence.EvidencePackSchema.safeParse(tests({ skippedBefore: 0, skippedAfter: 1 })).success).toBe(true);
    expect(evidence.EvidencePackSchema.safeParse(tests({ skippedBefore: 0 })).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(tests({ skippedBefore: 0, skippedAfter: 2 })).success).toBe(false);
  });
  it("refuses duplicate check ids, service names and scenario ids", () => {
    expect(evidence.EvidencePackSchema.safeParse(pack({ checks: [check(), check()] })).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(pack({ environment: { ...pack().environment, services: [pack().environment.services[0], pack().environment.services[0]] } })).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(pack({ api: [pack().api[0], pack().api[0]] })).success).toBe(false);
  });
  it("says why a video or trace is not there, and never both there and withheld", () => {
    const scenario = (extra: Record<string, unknown>) => pack({ browser: [{ scenarioId: "login", strip: { before: [], after: [] }, consoleErrors: 0, ...extra }] });
    expect(evidence.EvidencePackSchema.safeParse(scenario({ withheld: [{ artifact: "video", reason: "revocation_not_confirmed" }] })).success).toBe(true);
    expect(evidence.EvidencePackSchema.safeParse(scenario({ withheld: [{ artifact: "video", reason: "the provider said no" }] })).success).toBe(false);
    expect(evidence.EvidencePackSchema.safeParse(scenario({ video: ref("webm"), withheld: [{ artifact: "video", reason: "upload_failed" }] })).success).toBe(false);
  });
  it("takes the new not-tested kinds and no others", () => {
    for (const kind of ["claim", "scenario", "check", "mocked_service", "not_selected", "environment"]) expect(evidence.EvidencePackSchema.safeParse(pack({ notTested: [{ kind, id: "x", text: "t", reason: "r" }] })).success, kind).toBe(true);
    expect(evidence.EvidencePackSchema.safeParse(pack({ notTested: [{ kind: "other", id: "x", text: "t", reason: "r" }] })).success).toBe(false);
  });
});

describe("artifact refs and links", () => {
  it("keep each kind under its retention class: video and trace short, the rest standard", () => {
    expect(evidence.EVIDENCE_ARTIFACT_RETENTION).toEqual({ jpeg: "evidence-std", webm: "evidence-short", trace_zip: "evidence-short", api_sample_json: "evidence-std", log_txt: "evidence-std" });
    expect(evidence.ArtifactRefSchema.safeParse({ ...ref("webm"), retentionClass: "evidence-std" }).success).toBe(false);
    expect(evidence.ArtifactRefSchema.safeParse({ ...ref("jpeg"), retentionClass: "evidence-record" }).success).toBe(false);
  });
  it("cap the size of each kind", () => {
    for (const kind of evidence.EVIDENCE_ARTIFACT_KINDS) {
      const max = evidence.EVIDENCE_ARTIFACT_MAX_BYTES[kind];
      expect(evidence.ArtifactRefSchema.safeParse(ref(kind, "a", max)).success, kind).toBe(true);
      expect(evidence.ArtifactRefSchema.safeParse(ref(kind, "a", max + 1)).success, kind).toBe(false);
    }
    expect(evidence.EVIDENCE_ARTIFACT_MAX_BYTES).toMatchObject({ webm: 20 * 1_048_576, trace_zip: 25 * 1_048_576, jpeg: 524_288, api_sample_json: 16_384 });
  });
  it("name the magic bytes and content type of each binary kind", () => {
    expect(evidence.EVIDENCE_ARTIFACT_MAGIC).toEqual({ jpeg: "ffd8ff", webm: "1a45dfa3", trace_zip: "504b0304" });
    expect(evidence.EVIDENCE_ARTIFACT_CONTENT_TYPES.trace_zip).toBe("application/zip");
  });
  it("have an href exactly when the artifact is available, and only a Rovara route", () => {
    expect(evidence.ArtifactLinkSchema.safeParse(link("jpeg")).success).toBe(true);
    expect(evidence.ArtifactLinkSchema.safeParse({ ...link("jpeg"), state: "expired" }).success).toBe(false);
    const withoutHref: Record<string, unknown> = { ...link("jpeg") };
    delete withoutHref["href"];
    expect(evidence.ArtifactLinkSchema.safeParse({ ...withoutHref, state: "expired" }).success).toBe(true);
    expect(evidence.ArtifactLinkSchema.safeParse(withoutHref).success).toBe(false);
    for (const href of ["https://evil.example/x", "//evil.example/x", "/v1/app/../x?token=1", "javascript:alert(1)"]) expect(evidence.ArtifactLinkSchema.safeParse({ ...link("jpeg"), href }).success, href).toBe(false);
  });
});

describe("EvidenceView on the task view", () => {
  it("is the pack with links, and refuses a bare ref where a link belongs", () => {
    expect(evidence.EvidenceViewSchema.safeParse(view()).success).toBe(true);
    expect(evidence.EvidenceViewSchema.safeParse(pack()).success).toBe(false);
  });
  it("reads forward-compatibly: a field a newer server adds is kept, a new enum value reads as unknown", () => {
    const read = evidence.EvidenceViewReaderSchema.parse(view({ newer: true, checks: [check({ kind: "fuzz" })] })) as Record<string, unknown>;
    expect(read["newer"]).toBe(true);
    expect((read["checks"] as Array<Record<string, unknown>>)[0]?.["kind"]).toBe("unknown");
  });
  it("is an optional field of the task view: absent parses, a view parses, a bare pack does not", () => {
    const field = DeveloperTaskViewSchema.shape.evidence;
    expect(field.safeParse(undefined).success).toBe(true);
    expect(field.safeParse(view()).success).toBe(true);
    expect(field.safeParse(pack()).success).toBe(false);
    expect(DeveloperTaskViewReaderSchema).toBeDefined();
  });
});

describe("the version 1 task view projection", () => {
  const task = { taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", evidence: view() } as unknown as Parameters<typeof taskViewForClient>[0];
  it("leaves the evidence out for a client that does not ask for version 2, and keeps it for one that does", () => {
    expect("evidence" in taskViewForClient(task, {})).toBe(false);
    expect("evidence" in taskViewForClient(task, { "x-agentx-task-view": "1" })).toBe(false);
    expect("evidence" in taskViewForClient(task, { "X-AgentX-Task-View": "2" })).toBe(true);
  });
});

describe("the download contract", () => {
  const expired: Record<string, unknown> = { ...link("log_txt", "7"), state: "expired" };
  delete expired["href"];
  const current = evidence.EvidenceViewSchema.parse(view({ checks: [check({ outputTailRef: expired })] }));
  it("serves an artifact only when the task's current view names it and it is available", () => {
    expect(evidence.servableEvidenceArtifact(current, sha("c"), sha("b"))?.kind).toBe("jpeg");
    expect(evidence.servableEvidenceArtifact(current, sha("c"), sha("e"))?.kind).toBe("webm");
    expect(evidence.servableEvidenceArtifact(current, sha("c"), sha("a"))?.kind).toBe("api_sample_json");
  });
  it("never serves an expired artifact, a hash the view does not name (a withheld video the store still holds), a view for other code, or no view", () => {
    expect(evidence.servableEvidenceArtifact(current, sha("c"), sha("7"))).toBeUndefined();
    expect(evidence.servableEvidenceArtifact(current, sha("c"), sha("9"))).toBeUndefined();
    expect(evidence.servableEvidenceArtifact(current, sha("d"), sha("b"))).toBeUndefined();
    expect(evidence.servableEvidenceArtifact(current, undefined, sha("b"))).toBeUndefined();
    expect(evidence.servableEvidenceArtifact(undefined, sha("c"), sha("b"))).toBeUndefined();
  });
});

describe("check kinds", () => {
  it("are the design's eight, and a check with none is other", () => {
    expect([...evidence.CHECK_KINDS]).toEqual(["test", "lint", "typecheck", "security", "migration", "build", "smoke", "other"]);
    expect(evidence.checkKindOf(undefined)).toBe("other");
    expect(evidence.checkKindOf("lint")).toBe("lint");
  });
  it("are an optional field of a workflow check and of a check entry, so stored checks written before the field still parse", () => {
    const stored = { id: "unit", label: "Unit", command: { cwd: "repo", executable: "pytest", args: [], timeoutSeconds: 30 } };
    expect(WorkflowCheckSchema.safeParse(stored).success).toBe(true);
    expect(WorkflowCheckSchema.safeParse({ ...stored, kind: "test" }).success).toBe(true);
    expect(WorkflowCheckSchema.safeParse({ ...stored, kind: "fuzz" }).success).toBe(false);
    const entry = { id: "readiness:0", label: "pytest", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 1 };
    expect(CheckEntrySchema.safeParse(entry).success).toBe(true);
    expect(CheckEntrySchema.safeParse({ ...entry, kind: "typecheck" }).success).toBe(true);
    expect(CheckEntrySchema.safeParse({ ...entry, kind: "x" }).success).toBe(false);
  });
  it("keep the browser-safe outcome and class lists equal to the Node-side ones", () => {
    expect([...evidence.EVIDENCE_CHECK_OUTCOMES]).toEqual(CheckOutcomeSchema.options);
    expect([...evidence.EVIDENCE_CHECK_CLASSES]).toEqual(CheckClassSchema.options);
  });
});

describe("the proof table's extra words", () => {
  const table = (evidenceItem: Record<string, unknown>) => ({ rows: [{ claimId: "R1", requirement: "r", evidence: [{ kind: "check", label: "t", state: "proven", ...evidenceItem }], result: "proven" }], notTested: [], testProofLines: [] });
  it("take a fixed detail word and no other", () => {
    expect(ProofTableViewSchema.safeParse(table({ detail: "fails on old code" })).success).toBe(true);
    expect(ProofTableViewSchema.safeParse(table({})).success).toBe(true);
    expect(ProofTableViewSchema.safeParse(table({ detail: "AssertionError: 1 != 2 at /home/x" })).success).toBe(false);
  });
  it("take the new not-tested kinds", () => {
    const notTested = (kind: string) => ({ ...table({}), notTested: [{ kind, id: "x", text: "t", reason: "r" }] });
    expect(ProofTableViewSchema.safeParse(notTested("mocked_service")).success).toBe(true);
    expect(ProofTableViewSchema.safeParse(notTested("not_selected")).success).toBe(true);
    expect(ProofTableViewSchema.safeParse(notTested("environment")).success).toBe(true);
    expect(ProofTableViewSchema.safeParse(notTested("secret")).success).toBe(false);
  });
});

describe("retention", () => {
  it("defaults to 14 days for video and trace and 30 for the rest, and keeps the pack with the task", () => {
    expect(evidence.evidenceRetentionDays("evidence-short")).toBe(14);
    expect(evidence.evidenceRetentionDays("evidence-std")).toBe(30);
    expect(evidence.evidenceRetentionDays("evidence-record")).toBeNull();
  });
  it("lets a company set 1 to 90 days and 7 to 180 days, and clamps anything outside", () => {
    expect(evidence.evidenceRetentionDays("evidence-short", 1)).toBe(1);
    expect(evidence.evidenceRetentionDays("evidence-short", 0)).toBe(1);
    expect(evidence.evidenceRetentionDays("evidence-short", 400)).toBe(90);
    expect(evidence.evidenceRetentionDays("evidence-std", 3)).toBe(7);
    expect(evidence.evidenceRetentionDays("evidence-std", 181)).toBe(180);
    expect(evidence.evidenceRetentionDays("evidence-std", 1.5)).toBe(30);
  });
});

describe("pull request evidence mode", () => {
  it("defaults to a summary plus a link for both editions (owner decision, Proof Q8)", () => {
    expect(evidence.EVIDENCE_MODE_DEFAULT).toBe("link");
    expect(evidence.resolveEvidenceMode({ repositoryVisibility: "private", embedAllowed: false })).toBe("link");
  });
  it("embeds only for a private repository the company allows it for, and reads unknown visibility as public", () => {
    const input = { configured: "embed" as const, embedAllowed: true };
    expect(evidence.resolveEvidenceMode({ ...input, repositoryVisibility: "private" })).toBe("embed");
    expect(evidence.resolveEvidenceMode({ ...input, repositoryVisibility: "public" })).toBe("link");
    expect(evidence.resolveEvidenceMode({ ...input, repositoryVisibility: "unknown" })).toBe("link");
    expect(evidence.resolveEvidenceMode({ ...input, embedAllowed: false, repositoryVisibility: "private" })).toBe("link");
  });
  it("leaves summary alone, for a company whose pull request readers cannot sign in", () => {
    expect(evidence.resolveEvidenceMode({ configured: "summary", repositoryVisibility: "public", embedAllowed: false })).toBe("summary");
  });
});
