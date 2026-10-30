// Proof and evidence (design proof-test-env, section 3.2): the EvidencePack a task's checks, tests, coverage, API samples and browser runs add up to, and the
// view of it the task page reads. Browser-safe: nothing here imports a Node module. The worker writes the raw parts; the BROKER builds the pack, re-redacts every
// text and checks every count against the files, so a worker's own summary is never taken as truth. Every list and string is bounded, every text is one plain line
// (no control or format characters) that readers escape for their own markup, and a pack for any other candidate digest is ignored by the broker.
import { z } from "zod";
import { forwardReader } from "./forward-reader.js";
import { TestProofVerdictSchema } from "./test-proof.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const CountSchema = z.number().int().min(0).max(100_000_000);

/** One line of plain text: no control or format characters (a newline, an escape, a bidirectional override), so no reader can be misled about what a label says. */
const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
function line(max: number, min = 1) {
  return z.string().min(min).max(max).regex(NO_HIDDEN, "one plain line");
}

// ---- check kinds and outcomes

/** What a check is for. The setup agent proposes it and the maintainer confirms it; a check with none is `other`. */
export const CHECK_KINDS = ["test", "lint", "typecheck", "security", "migration", "build", "smoke", "other"] as const;
export const CheckKindSchema = z.enum(CHECK_KINDS);
export type CheckKind = z.infer<typeof CheckKindSchema>;
/** A check with no recorded kind is `other`. */
export function checkKindOf(kind: CheckKind | undefined): CheckKind {
  return kind ?? "other";
}

/** Browser-safe copies of `CheckOutcomeSchema` and `CheckClassSchema` (checks.ts is Node-only); a contract test keeps them equal. */
export const EVIDENCE_CHECK_OUTCOMES = ["passed", "failed", "timed_out", "unknown", "not_run"] as const;
export const EVIDENCE_CHECK_CLASSES = ["passing", "regression", "already_failing", "fixed", "failing_no_before", "not_rerun"] as const;

// ---- artifacts: kinds, size caps and retention classes

/**
 * Retention classes, applied as an S3 lifecycle tag per artifact kind.
 * evidence-short: video and trace. evidence-std: screenshots, API samples, output tails. evidence-record: the pack itself, which lives with the task record.
 */
export const EVIDENCE_RETENTION_CLASSES = ["evidence-short", "evidence-std", "evidence-record"] as const;
export const EvidenceRetentionClassSchema = z.enum(EVIDENCE_RETENTION_CLASSES);
export type EvidenceRetentionClass = z.infer<typeof EvidenceRetentionClassSchema>;

export const EVIDENCE_ARTIFACT_KINDS = ["jpeg", "webm", "trace_zip", "api_sample_json", "log_txt"] as const;
export const EvidenceArtifactKindSchema = z.enum(EVIDENCE_ARTIFACT_KINDS);
export type EvidenceArtifactKind = z.infer<typeof EvidenceArtifactKindSchema>;

/** The class each kind is kept under. */
export const EVIDENCE_ARTIFACT_RETENTION: Record<EvidenceArtifactKind, EvidenceRetentionClass> = {
  jpeg: "evidence-std",
  webm: "evidence-short",
  trace_zip: "evidence-short",
  api_sample_json: "evidence-std",
  log_txt: "evidence-std",
};

/** The most bytes one artifact of each kind may be; a ref that claims more is refused. */
export const EVIDENCE_ARTIFACT_MAX_BYTES: Record<EvidenceArtifactKind, number> = {
  jpeg: 524_288,
  webm: 20 * 1_048_576,
  trace_zip: 25 * 1_048_576,
  api_sample_json: 16_384,
  log_txt: 65_536,
};

/** The content type each kind is served with, and the magic bytes the store checks before it keeps one (hex). Plain text and JSON have no magic bytes: they are parsed. */
export const EVIDENCE_ARTIFACT_CONTENT_TYPES: Record<EvidenceArtifactKind, string> = {
  jpeg: "image/jpeg",
  webm: "video/webm",
  trace_zip: "application/zip",
  api_sample_json: "application/json",
  log_txt: "text/plain",
};
export const EVIDENCE_ARTIFACT_MAGIC: Partial<Record<EvidenceArtifactKind, string>> = { jpeg: "ffd8ff", webm: "1a45dfa3", trace_zip: "504b0304" };

/** Days an artifact is kept, per class: the default and the range a company may set (Enterprise). The pilot's Public edition keeps the defaults. */
export const EVIDENCE_RETENTION_DAYS = {
  "evidence-short": { default: 14, min: 1, max: 90 },
  "evidence-std": { default: 30, min: 7, max: 180 },
} as const;

/** The days an artifact of `retentionClass` is kept, given a company setting (the default when there is none, and always inside the allowed range). `evidence-record` lives with the task: null. */
export function evidenceRetentionDays(retentionClass: EvidenceRetentionClass, configured?: number): number | null {
  if (retentionClass === "evidence-record") return null;
  const rule = EVIDENCE_RETENTION_DAYS[retentionClass];
  if (configured === undefined || !Number.isInteger(configured)) return rule.default;
  return Math.min(rule.max, Math.max(rule.min, configured));
}

/** What the pack holds about one stored artifact: never its bytes. */
export const ArtifactRefSchema = z
  .object({
    kind: EvidenceArtifactKindSchema,
    sha256: Sha256Schema,
    bytes: z.number().int().min(0),
    retentionClass: EvidenceRetentionClassSchema,
  })
  .strict()
  .superRefine((ref, context) => {
    if (ref.retentionClass !== EVIDENCE_ARTIFACT_RETENTION[ref.kind]) context.addIssue({ code: "custom", path: ["retentionClass"], message: "an artifact is kept under its kind's retention class" });
    if (ref.bytes > EVIDENCE_ARTIFACT_MAX_BYTES[ref.kind]) context.addIssue({ code: "custom", path: ["bytes"], message: "an artifact is no larger than its kind's cap" });
  });
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

/**
 * What the task page gets for an artifact: the ref and the route that serves it (a 60-second presigned URL after a per-request access check), or why there is no route.
 * `href` is present exactly when `state` is `available`.
 */
export const ARTIFACT_LINK_STATES = ["available", "expired", "withheld"] as const;
export const EvidenceHrefSchema = z.string().max(512).regex(/^\/v1\/app\/[A-Za-z0-9/_.~-]+$/u, "a Rovara route");
export const ArtifactLinkSchema = z
  .object({
    kind: EvidenceArtifactKindSchema,
    sha256: Sha256Schema,
    bytes: z.number().int().min(0),
    retentionClass: EvidenceRetentionClassSchema,
    state: z.enum(ARTIFACT_LINK_STATES),
    href: EvidenceHrefSchema.optional(),
  })
  .strict()
  .superRefine((link, context) => {
    if ((link.state === "available") !== (link.href !== undefined)) context.addIssue({ code: "custom", path: ["href"], message: "href is there exactly when the artifact is available" });
    if (link.retentionClass !== EVIDENCE_ARTIFACT_RETENTION[link.kind]) context.addIssue({ code: "custom", path: ["retentionClass"], message: "an artifact is kept under its kind's retention class" });
    if (link.bytes > EVIDENCE_ARTIFACT_MAX_BYTES[link.kind]) context.addIssue({ code: "custom", path: ["bytes"], message: "an artifact is no larger than its kind's cap" });
  });
export type ArtifactLink = z.infer<typeof ArtifactLinkSchema>;

// ---- the pack

export const EVIDENCE_TIERS = ["sandbox", "preview", "shared"] as const;
export const EVIDENCE_SERVICE_MODES = ["preprod", "mocked", "live-forbidden"] as const;
export const EVIDENCE_ACCOUNT_KINDS = ["run_scoped", "registered"] as const;
export const EVIDENCE_SELECTION_METHODS = ["coverage_map", "import_graph", "declared", "full"] as const;
/** Why a video or a trace is not on the page (fixed words, never an error text). */
export const EVIDENCE_WITHHELD_REASONS = ["account_not_run_scoped", "tier_not_allowed", "data_not_synthetic", "company_setting_off", "revocation_not_confirmed", "size_over_cap", "upload_failed"] as const;
export const EVIDENCE_NOT_TESTED_KINDS = ["claim", "scenario", "check", "mocked_service", "not_selected", "environment"] as const;
export const EVIDENCE_FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export const EVIDENCE_TEST_STATUSES = ["passed", "failed", "skipped", "errored"] as const;

export const EVIDENCE_CHECKS_MAX = 64;
export const EVIDENCE_TEST_NAMES_MAX = 500;
export const EVIDENCE_NEW_TESTS_MAX = 100;
export const EVIDENCE_TEST_NAMES_TOTAL_MAX = 2_000;
export const EVIDENCE_COVERAGE_FILES_MAX = 100;
export const EVIDENCE_UNCOVERED_LINES_MAX = 200;
export const EVIDENCE_FINDINGS_MAX = 100;
export const EVIDENCE_SCENARIOS_MAX = 64;
export const EVIDENCE_API_SAMPLES_MAX = 5;
export const EVIDENCE_STRIP_MAX = 6;
export const EVIDENCE_NOT_TESTED_MAX = 200;

export const EvidenceTestSchema = z
  .object({
    name: line(300),
    status: z.enum(EVIDENCE_TEST_STATUSES),
    /** TESTPROOF's verdict for this test, when the check wrote a per-test report and the test is new or changed. */
    proof: TestProofVerdictSchema.optional(),
    durationMs: z.number().int().min(0).max(86_400_000).optional(),
  })
  .strict();
export type EvidenceTest = z.infer<typeof EvidenceTestSchema>;

export const EvidenceFindingSchema = z
  .object({
    ruleId: line(100),
    severity: z.enum(EVIDENCE_FINDING_SEVERITIES),
    path: line(500),
    line: z.number().int().min(1).max(10_000_000),
    /** The tool's message, redacted by the broker and plain text for every reader. */
    message: line(300, 0),
  })
  .strict();
export type EvidenceFinding = z.infer<typeof EvidenceFindingSchema>;

export const EvidenceEnvironmentSchema = z
  .object({
    tier: z.enum(EVIDENCE_TIERS),
    envRevision: z.number().int().min(0),
    services: z
      .array(
        z
          .object({
            name: line(80),
            mode: z.enum(EVIDENCE_SERVICE_MODES),
            fixtureRevision: z.number().int().min(0).optional(),
            schemaVersion: z.number().int().min(1).optional(),
            recordedAt: z.string().datetime().optional(),
            /** Requests a mock answered without a recording (`schema_synth`): counted, never hidden. */
            unrecordedAnswered: CountSchema.optional(),
          })
          .strict(),
      )
      .max(32),
    data: z.literal("synthetic"),
    accounts: z.array(z.object({ profileId: line(120), kind: z.enum(EVIDENCE_ACCOUNT_KINDS) }).strict()).max(16),
  })
  .strict();
export type EvidenceEnvironment = z.infer<typeof EvidenceEnvironmentSchema>;
export const EvidenceNotTestedSchema = z.object({ kind: z.enum(EVIDENCE_NOT_TESTED_KINDS), id: line(64), text: line(300, 0), reason: line(100) }).strict();
export type EvidenceNotTested = z.infer<typeof EvidenceNotTestedSchema>;

const SeverityCountsSchema = z.object({ critical: CountSchema, high: CountSchema, medium: CountSchema, low: CountSchema, info: CountSchema }).strict();

/** The parts of a check's evidence that do not hold an artifact: the worker reports them and the broker verifies them. */
export const EvidenceChecksTestsSchema = z
  .object({
    total: CountSchema,
    passed: CountSchema,
    failed: CountSchema,
    skipped: CountSchema,
    errored: CountSchema,
    /** Skips among tests the change did not touch, on the run before (the original code or the baseline) and on this run: a rise is shown as a not-tested reason. Both or neither. */
    skippedBefore: CountSchema.optional(),
    skippedAfter: CountSchema.optional(),
    names: z.array(EvidenceTestSchema).max(EVIDENCE_TEST_NAMES_MAX),
    newTests: z.array(line(300)).max(EVIDENCE_NEW_TESTS_MAX),
  })
  .strict();
export const EvidenceCoverageSchema = z
  .object({
    linesChanged: CountSchema,
    linesCovered: CountSchema,
    files: z.array(z.object({ path: line(500), uncovered: z.array(z.number().int().min(1).max(10_000_000)).max(EVIDENCE_UNCOVERED_LINES_MAX) }).strict()).max(EVIDENCE_COVERAGE_FILES_MAX),
  })
  .strict();
export const EvidenceFindingsSchema = z.object({ tool: line(60), newCount: CountSchema, bySeverity: SeverityCountsSchema, items: z.array(EvidenceFindingSchema).max(EVIDENCE_FINDINGS_MAX) }).strict();
export const EvidenceMigrationsSchema = z.object({ applied: z.array(line(100)).max(50), rolledBack: z.boolean().nullable(), schemaChanges: z.array(line(200)).max(100) }).strict();
export const EvidenceSelectionSchema = z
  .object({
    method: z.enum(EVIDENCE_SELECTION_METHODS),
    selected: CountSchema,
    total: CountSchema,
    mapAgeHours: z.number().int().min(0).max(100_000).optional(),
    fallbackReason: z.enum(["full_suite_on_path", "map_missing", "map_stale", "unknown_file", "over_selected", "no_template"]).optional(),
    lastFullRun: z.object({ at: z.string().datetime(), status: z.enum(["passed", "failed"]), passed: CountSchema, total: CountSchema, flaky: CountSchema }).strict().optional(),
  })
  .strict();

/** Consistency every check's parts must keep, wherever they came from (the worker's raw parts and the broker's pack). */
function checkPartsProblems(entry: { tests?: z.infer<typeof EvidenceChecksTestsSchema> | undefined; coverage?: z.infer<typeof EvidenceCoverageSchema> | undefined; findings?: z.infer<typeof EvidenceFindingsSchema> | undefined }, issue: (path: (string | number)[], message: string) => void): void {
  const tests = entry.tests;
  if (tests !== undefined && tests.total !== tests.passed + tests.failed + tests.skipped + tests.errored) issue(["tests", "total"], "total is passed, failed, skipped and errored together");
  if (tests !== undefined && (tests.skippedBefore === undefined) !== (tests.skippedAfter === undefined)) issue(["tests", "skippedAfter"], "skippedBefore and skippedAfter come together");
  if (tests?.skippedAfter !== undefined && tests.skippedAfter > tests.skipped) issue(["tests", "skippedAfter"], "skips among untouched tests are some of the skips");
  if (entry.coverage !== undefined && entry.coverage.linesCovered > entry.coverage.linesChanged) issue(["coverage", "linesCovered"], "covered lines are some of the changed lines");
  if (entry.findings !== undefined && entry.findings.newCount !== Object.values(entry.findings.bySeverity).reduce((sum, count) => sum + count, 0)) issue(["findings", "newCount"], "newCount is the severities together");
}

export function evidencePackShape<A extends z.ZodType>(artifact: A) {
  const check = z
    .object({
      checkId: line(64),
      kind: CheckKindSchema,
      label: line(200),
      before: z.enum(EVIDENCE_CHECK_OUTCOMES),
      after: z.enum(EVIDENCE_CHECK_OUTCOMES),
      class: z.enum(EVIDENCE_CHECK_CLASSES),
      durationMs: z.number().int().min(0),
      exitCode: z.number().int().nullable().optional(),
      tests: EvidenceChecksTestsSchema.optional(),
      coverage: EvidenceCoverageSchema.optional(),
      findings: EvidenceFindingsSchema.optional(),
      migrations: EvidenceMigrationsSchema.optional(),
      outputTailRef: artifact.optional(),
    })
    .strict()
    .superRefine((entry, context) => checkPartsProblems(entry, (path, message) => context.addIssue({ code: "custom", path, message })));

  const api = z
    .array(z.object({ scenarioId: line(120), samples: z.array(artifact).max(EVIDENCE_API_SAMPLES_MAX), diff: z.enum(["none", "changed", "no_baseline"]), changedPaths: z.array(line(300)).max(50) }).strict())
    .max(EVIDENCE_SCENARIOS_MAX);
  const browser = z
    .array(
      z
        .object({
          scenarioId: line(120),
          strip: z.object({ before: z.array(artifact).max(EVIDENCE_STRIP_MAX), after: z.array(artifact).max(EVIDENCE_STRIP_MAX) }).strict(),
          video: artifact.optional(),
          trace: artifact.optional(),
          consoleErrors: CountSchema,
          withheld: z.array(z.object({ artifact: z.enum(["video", "trace"]), reason: z.enum(EVIDENCE_WITHHELD_REASONS) }).strict()).max(2).optional(),
        })
        .strict(),
    )
    .max(EVIDENCE_SCENARIOS_MAX);

  return z
    .object({
      schemaVersion: z.literal(1),
      /** The code the checks ran on. A pack for any other digest is ignored. */
      candidateDigest: Sha256Schema,
      environment: EvidenceEnvironmentSchema,
      checks: z.array(check).max(EVIDENCE_CHECKS_MAX),
      selection: EvidenceSelectionSchema,
      api,
      browser,
      notTested: z.array(EvidenceNotTestedSchema).max(EVIDENCE_NOT_TESTED_MAX),
    })
    .strict()
    .superRefine((pack, context) => {
      const duplicate = (values: readonly string[]) => new Set(values).size !== values.length;
      if (duplicate(pack.checks.map((entry) => entry.checkId))) context.addIssue({ code: "custom", path: ["checks"], message: "check ids are unique" });
      if (duplicate(pack.environment.services.map((service) => service.name))) context.addIssue({ code: "custom", path: ["environment", "services"], message: "service names are unique" });
      if (duplicate(pack.api.map((entry) => entry.scenarioId))) context.addIssue({ code: "custom", path: ["api"], message: "API scenarios are unique" });
      if (duplicate(pack.browser.map((entry) => entry.scenarioId))) context.addIssue({ code: "custom", path: ["browser"], message: "browser scenarios are unique" });
      if (pack.checks.reduce((sum, entry) => sum + (entry.tests?.names.length ?? 0), 0) > EVIDENCE_TEST_NAMES_TOTAL_MAX) context.addIssue({ code: "custom", path: ["checks"], message: "a pack names at most 2,000 tests in all" });
      if (pack.selection.selected > pack.selection.total) context.addIssue({ code: "custom", path: ["selection", "selected"], message: "selected is some of the total" });
      for (const [index, scenario] of pack.browser.entries()) {
        for (const kind of ["video", "trace"] as const) {
          if (scenario[kind] !== undefined && scenario.withheld?.some((item) => item.artifact === kind) === true) context.addIssue({ code: "custom", path: ["browser", index, "withheld"], message: `${kind} is either there or withheld` });
        }
      }
    });
}

/** What the broker builds from the worker's raw parts and keeps with the task record (`evidence-record`). */
export const EvidencePackSchema = evidencePackShape(ArtifactRefSchema);
export type EvidencePack = z.infer<typeof EvidencePackSchema>;

/** What the task page reads (version 2 views, full reads only): the pack with each artifact as a link, or as expired or withheld. */
export const EvidenceViewSchema = evidencePackShape(ArtifactLinkSchema);
export type EvidenceView = z.infer<typeof EvidenceViewSchema>;
export const EvidenceViewReaderSchema = forwardReader(EvidenceViewSchema);

/**
 * What the worker writes at the end of a CHECKS run (`evidence-raw.json`, through the evidence upload path) and the broker reads as UNTRUSTED input: the parts only a worker can know (a check's test
 * report, coverage, findings, migrations and output tail, the test selection, and the API and browser artifacts it uploaded). The broker takes labels, outcomes and classes from its own check report and
 * the environment from the approved setting, so none of those is here. A file larger than `EVIDENCE_RAW_MAX_BYTES` is not read.
 */
export const EVIDENCE_RAW_ARTIFACT = "evidence-raw.json";
export const EVIDENCE_RAW_MAX_BYTES = 2 * 1_048_576;
export const EvidenceRawCheckSchema = z
  .object({
    checkId: line(64),
    tests: EvidenceChecksTestsSchema.optional(),
    coverage: EvidenceCoverageSchema.optional(),
    findings: EvidenceFindingsSchema.optional(),
    migrations: EvidenceMigrationsSchema.optional(),
    /** The redacted tail of the check's output; the broker stores it as a `log_txt` artifact. */
    outputTail: z.string().max(EVIDENCE_ARTIFACT_MAX_BYTES.log_txt).optional(),
  })
  .strict()
  .superRefine((entry, context) => checkPartsProblems(entry, (path, message) => context.addIssue({ code: "custom", path, message })));
export const EvidenceRawSchema = z
  .object({
    schemaVersion: z.literal(1),
    candidateDigest: Sha256Schema,
    checks: z.array(EvidenceRawCheckSchema).max(EVIDENCE_CHECKS_MAX),
    selection: EvidenceSelectionSchema.optional(),
    api: EvidencePackSchema.shape.api.optional(),
    browser: EvidencePackSchema.shape.browser.optional(),
  })
  .strict()
  .superRefine((raw, context) => {
    if (new Set(raw.checks.map((entry) => entry.checkId)).size !== raw.checks.length) context.addIssue({ code: "custom", path: ["checks"], message: "check ids are unique" });
  });
export type EvidenceRaw = z.infer<typeof EvidenceRawSchema>;

/** True when the pack is for exactly this candidate. Any other digest means the pack is for other code, and it is ignored. */
export function evidenceIsFor(pack: Pick<EvidencePack, "candidateDigest"> | undefined, candidateDigest: string): boolean {
  return pack !== undefined && pack.candidateDigest === candidateDigest;
}

// ---- the proof table's extra words and the pull request's evidence mode

/** The fixed words a proof row's evidence may add after its label (the Proof table's `detail`). Never a test's or a repository's own words. */
export const PROOF_DETAILS = ["fails on old code", "passes on old code too", "not run on old code", "no API diff", "API fields changed", "no baseline to compare", "before and after screenshots"] as const;
export const ProofDetailSchema = z.enum(PROOF_DETAILS);
export type ProofDetail = z.infer<typeof ProofDetailSchema>;

/**
 * What the pull request carries of the evidence (a company setting, lockable; per project when not locked).
 * summary: counts and labels only, no link. link: the same plus a link to the task page behind sign-in. embed (less safe): also the after screenshot of each UI scenario as an image, private repositories only.
 */
export const EVIDENCE_MODES = ["summary", "link", "embed"] as const;
export const EvidenceModeSchema = z.enum(EVIDENCE_MODES);
export type EvidenceMode = z.infer<typeof EvidenceModeSchema>;
/** Owner decision 2026-10-30 (DECISIONS.md, Proof Q8): both editions default to a summary on the pull request plus a link to the full evidence behind sign-in. */
export const EVIDENCE_MODE_DEFAULT: EvidenceMode = "link";

/**
 * The mode a pull request is written with. Fails closed: `embed` is used only for a private repository whose visibility was just read and only when the company allows it
 * (otherwise it is `link`), and an unknown visibility is read as public.
 */
export function resolveEvidenceMode(input: { configured?: EvidenceMode; repositoryVisibility: "private" | "public" | "unknown"; embedAllowed: boolean }): EvidenceMode {
  const mode = input.configured ?? EVIDENCE_MODE_DEFAULT;
  if (mode === "embed" && !(input.embedAllowed && input.repositoryVisibility === "private")) return "link";
  return mode;
}
