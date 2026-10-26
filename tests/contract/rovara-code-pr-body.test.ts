// Plan 6 Task 13: the pull request description of a Rovara Code (version 2) task, and the risk level. The risk level comes from defined inputs (the paths and size of the change,
// the checks, the findings the owner accepted and the code reviewer's own level), never from free model text. The description is public to the repository's readers: every
// model-written line is redacted and made inert (no mention, link or cross-reference), the whole body is bounded, and a version 1 task's description is exactly as before.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RiskAssessmentSchema, type VerificationReport } from "../../packages/contracts/src/index.js";
import {
  WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, workflowFindingFingerprint, type WorkflowSnapshot,
} from "../../packages/contracts/src/task-workflow.js";
import { RISK_SENSITIVE_PATH_PATTERNS, assessRisk, isSensitivePath, type RiskInput } from "../../packages/broker/src/rovara-code/risk.js";
import { recomputeRisk } from "../../packages/broker/src/rovara-code/pull-request-body.js";
import { workflowPullRequestBody, workflowPullRequestStatusLines } from "../../packages/broker/src/aws/developer-tasks.js";
import { withStatusLines } from "../../packages/broker/src/developer/pull-request-feedback-section.js";
import { workflowDispatchItem } from "../../packages/broker/src/aws/broker-shared.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const now = "2026-10-25T12:00:00.000Z";
const digest = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]).digest;
const candidate = (letter: string) => createCandidateManifest([{ repositoryId: "payments", commitSha: letter.repeat(40), treeSha: letter.repeat(40), baseCommitSha: "e".repeat(40) }]);
const check = (id: string, label: string) => ({ id, label, command: { cwd: "repo/payments", executable: "npm", args: ["test"], timeoutSeconds: 30 } });

const cleanReport: VerificationReport = { reviewOnly: false, passed: [{ label: "Unit tests" }], failed: [], notChecked: [], testsAdded: [] };
const file = (path: string, added = 3, removed = 1) => ({ repository: "payments", path, added, removed });
function riskInput(overrides: Partial<RiskInput> = {}): RiskInput {
  return { changedFiles: [file("src/retry.ts")], changedFilesComplete: true, report: cleanReport, acceptedFindings: [], securityFindings: 0, candidateDigest: digest, ...overrides };
}

describe("assessRisk", () => {
  it("a small change with nothing else to say is low, with its one reason", () => {
    const risk = assessRisk(riskInput());
    expect(risk.level).toBe("low");
    expect(risk.reasons).toHaveLength(1);
    expect(risk.candidateDigest).toBe(digest);
    expect(RiskAssessmentSchema.safeParse(risk).success).toBe(true);
  });

  it("db/migrations/001.sql is high", () => {
    const risk = assessRisk(riskInput({ changedFiles: [file("db/migrations/001.sql")] }));
    expect(risk.level).toBe("high");
    expect(risk.reasons.join("\n")).toContain("db/migrations/001.sql");
  });

  it("matches path segments, not substrings: src/author.ts and src/diamond.ts are not high", () => {
    for (const path of ["src/author.ts", "src/diamond.ts", "src/authored/list.ts", "src/payments-ui.ts", "docs/infrastructure.md", "src/secretsanta.ts", "src/cdk8s.ts",
      // A directory that only ends like a sensitive one is not one either.
      "src/oauth/x.ts", "src/reauth/x.ts", "lib/preauthz/x.ts", "lib/subiam/x.ts", "app/nonmigrations/x.ts", "app/myinfra/x.ts"]) {
      expect(assessRisk(riskInput({ changedFiles: [file(path)] })).level, path).toBe("low");
    }
  });

  it("every sensitive directory, file pattern and the workflows folder is high, in any folder and in any case", () => {
    for (const path of [
      "migrations/1.ts", "app/auth/login.ts", "authn/x.ts", "a/authz/x.ts", "payments/charge.ts", "svc/billing/invoice.ts", "secrets/x.json", "iam/policy.json", "infra/main.ts",
      "terraform/net.tf", "cdk/stack.ts", ".github/workflows/ci.yml", "schema.sql", "deploy/main.tf", "Dockerfile", "services/api/Dockerfile", "Auth/Login.ts", "Db/Migrations/2.ts",
    ]) {
      expect(isSensitivePath(path), path).toBe(true);
      expect(assessRisk(riskInput({ changedFiles: [file(path)] })).level, path).toBe("high");
    }
    // The workflows folder is two segments; neither alone is sensitive.
    expect(isSensitivePath(".github/CODEOWNERS")).toBe(false);
    expect(isSensitivePath("docs/workflows/overview.md")).toBe(false);
    expect(isSensitivePath("src/Dockerfile.md")).toBe(false);
    expect(RISK_SENSITIVE_PATH_PATTERNS.length).toBeGreaterThan(0);
  });

  it("450 lines is medium, 400 is not, and a count covers both added and removed lines", () => {
    expect(assessRisk(riskInput({ changedFiles: [file("src/a.ts", 450, 0)] })).level).toBe("medium");
    expect(assessRisk(riskInput({ changedFiles: [file("src/a.ts", 400, 0)] })).level).toBe("low");
    expect(assessRisk(riskInput({ changedFiles: [file("src/a.ts", 401, 0)] })).level).toBe("medium");
    expect(assessRisk(riskInput({ changedFiles: [file("src/a.ts", 200, 0), file("src/b.ts", 100, 101)] })).level).toBe("medium");
    expect(assessRisk(riskInput({ changedFiles: [file("src/a.ts", 200, 0), file("src/b.ts", 100, 100)] })).level).toBe("low");
  });

  it("a lock file or a manifest is medium", () => {
    for (const path of ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "web/package.json", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum", "requirements.txt", "poetry.lock", "pyproject.toml", "Gemfile.lock", "pom.xml", "build.gradle"]) {
      expect(assessRisk(riskInput({ changedFiles: [file(path)] })).level, path).toBe("medium");
    }
    expect(assessRisk(riskInput({ changedFiles: [file("docs/package.json.md")] })).level).toBe("low");
  });

  it("a review-only change, a failed check and a check that couldn't run are each medium", () => {
    expect(assessRisk(riskInput({ report: { ...cleanReport, reviewOnly: true, passed: [], notChecked: [{ label: "Automated checks", reason: "Docs only" }] } })).level).toBe("medium");
    expect(assessRisk(riskInput({ report: { ...cleanReport, failed: [{ label: "Lint", summary: "It failed on the latest code." }] } })).level).toBe("medium");
    expect(assessRisk(riskInput({ report: { ...cleanReport, notChecked: [{ label: "Types", reason: "It never started." }] } })).level).toBe("medium");
  });

  it("an accepted code finding is medium and an accepted security finding is high", () => {
    expect(assessRisk(riskInput({ acceptedFindings: [{ role: "CRITIC" }] })).level).toBe("medium");
    expect(assessRisk(riskInput({ acceptedFindings: [{ role: "SECURITY" }] })).level).toBe("high");
    // A security finding the review introduced counts even when the accepted list no longer holds it.
    expect(assessRisk(riskInput({ securityFindings: 1 })).level).toBe("high");
  });

  it("the reviewer's high raises low, the reviewer's medium raises low, and the reviewer's low lowers nothing", () => {
    expect(assessRisk(riskInput({ reviewerRisk: "high" })).level).toBe("high");
    expect(assessRisk(riskInput({ reviewerRisk: "medium" })).level).toBe("medium");
    expect(assessRisk(riskInput({ reviewerRisk: "low" })).level).toBe("low");
    expect(assessRisk(riskInput({ changedFiles: [file("infra/main.ts")], reviewerRisk: "low" })).level).toBe("high");
    expect(assessRisk(riskInput({ changedFiles: [file("package.json")], reviewerRisk: "low" })).level).toBe("medium");
  });

  it("the highest matching rule wins, and every match adds its reason", () => {
    const risk = assessRisk(riskInput({
      changedFiles: [file("infra/main.ts", 300, 200), file("package.json")], report: { ...cleanReport, failed: [{ label: "Lint", summary: "x" }] },
      acceptedFindings: [{ role: "SECURITY" }, { role: "CRITIC" }], reviewerRisk: "high",
    }));
    expect(risk.level).toBe("high");
    const text = risk.reasons.join("\n");
    expect(text).toContain("infra/main.ts");
    expect(text).toMatch(/security/i);
    expect(text).toMatch(/code review/i);
    expect(text).toMatch(/lines/i);
    expect(text).toMatch(/package\.json/);
    expect(risk.reasons.length).toBeLessThanOrEqual(8);
    expect(risk.reasons.every((reason) => reason.length >= 1 && reason.length <= 200)).toBe(true);
    expect(RiskAssessmentSchema.safeParse(risk).success).toBe(true);
  });

  it("every rule at once still gives a valid assessment of at most 8 reasons, with the high ones first", () => {
    const risk = assessRisk(riskInput({
      changedFiles: [file("infra/main.ts", 500, 0), file("package.json")], changedFilesComplete: false, report: { ...cleanReport, reviewOnly: true, failed: [{ label: "Lint", summary: "x" }], notChecked: [{ label: "Types", reason: "y" }] },
      acceptedFindings: [{ role: "SECURITY" }, { role: "CRITIC" }], securityFindings: 2, reviewerRisk: "high",
    }));
    expect(risk.level).toBe("high");
    expect(risk.reasons).toHaveLength(8);
    expect(risk.reasons.slice(0, 3).join("\n")).toMatch(/sensitive paths[\s\S]*security[\s\S]*code review/i);
    expect(RiskAssessmentSchema.safeParse(risk).success).toBe(true);
  });

  it("a change whose files couldn't all be read is at least medium, never low", () => {
    expect(assessRisk(riskInput({ changedFiles: [], changedFilesComplete: false })).level).toBe("medium");
    expect(assessRisk(riskInput({ changedFiles: [file("src/a.ts")], changedFilesComplete: false })).level).toBe("medium");
    expect(assessRisk(riskInput({ changedFiles: [file("infra/x.ts")], changedFilesComplete: false })).level).toBe("high");
  });

  it("file names are untrusted: a reason has no mention, no link, no line break and no secret, and stays in its limit", () => {
    const hostile = `infra/@octocat/https://evil.example/ghp_abcdefghijklmnopqrstuvwxyz0123456789\n# injected ${"x".repeat(400)}.tf`;
    const risk = assessRisk(riskInput({ changedFiles: [file(hostile), file("auth/@everyone.ts"), file("iam/[click](http://e.example).ts")] }));
    expect(risk.level).toBe("high");
    for (const reason of risk.reasons) {
      expect(reason).not.toMatch(/\n/);
      expect(reason).not.toContain("ghp_");
      expect(reason.length).toBeLessThanOrEqual(200);
    }
    expect(RiskAssessmentSchema.safeParse(risk).success).toBe(true);
  });
});

// ---- the description

function workflowWith(extra: Record<string, unknown> = {}, definitionVersion: "1.0.0" | "1.1.0" = "1.1.0"): WorkflowSnapshot {
  const code = candidate("1");
  const review = (role: "CRITIC" | "SECURITY", more: Record<string, unknown> = {}) => ({
    operationId: randomUUID(), candidateDigest: code.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now, ...more,
  });
  return WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId, ownerId, now, definitionVersion }),
    stage: "PULL_REQUEST", state: "READY", candidate: code,
    checkPolicy: { required: [check("unit", "Unit tests")], optional: [], selectedOptionalIds: [], proposed: [] },
    verification: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: [review("CRITIC"), review("SECURITY")],
    ...extra,
  });
}
const task = { title: "Add a retry flag" } as never;
const SESSION = "https://rovara.example/review/8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6/task";
const CLOSING = "Opened by Rovara after the approved plan, checks and reviews. A person must approve it and a person merges it.";
const START = "<!-- rovara:checks-and-reviews -->";
const END = "<!-- /rovara:checks-and-reviews -->";
const context = (extra: Record<string, unknown> = {}) => ({
  changedFiles: { files: [file("src/retry.ts", 10, 2), file("src/retry.test.ts", 30, 0)], complete: true }, ...extra,
});
const planOf = "# Plan\n\n1. Add the retry flag.\n2. Add a regression test.\n";

describe("the version 2 pull request description", () => {
  it("has its sections in order, the plan summary first, the session link and the closing line last, and never says AgentX", () => {
    const body = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context());
    const at = (text: string) => body.indexOf(text);
    const order = ["Add the retry flag.", START, "## What changed", "## Tests", "## Reviews", "## Risk: Low", END, `Rovara session: ${SESSION}`, CLOSING];
    for (const text of order) expect(at(text), text).toBeGreaterThanOrEqual(0);
    for (let index = 1; index < order.length; index += 1) expect(at(order[index]!), order[index]).toBeGreaterThan(at(order[index - 1]!));
    expect(body.trimEnd().endsWith(CLOSING)).toBe(true);
    expect(body).not.toMatch(/agentx/i);
    expect(body).not.toContain("Opened as a draft");
    expect(body.split(START)).toHaveLength(2);
    expect(body.split(END)).toHaveLength(2);
  });

  it("What changed lists the files with their line counts, and Tests lists what passed and the tests added", () => {
    const report = workflowWith();
    const body = workflowPullRequestBody(task, report, planOf, SESSION, context());
    expect(body).toContain("src/retry.ts");
    expect(body).toContain("+10");
    expect(body).toContain("src/retry.test.ts");
    const tests = body.slice(body.indexOf("## Tests"), body.indexOf("## Reviews"));
    expect(tests).toContain("Unit tests");
    expect(tests).toContain("src/retry.test.ts");
    expect(body.slice(body.indexOf("## Reviews"), body.indexOf("## Risk:"))).toContain("code review passed; security review passed");
  });

  it("says when the changed files couldn't be listed, and doesn't pretend that no test was added", () => {
    const body = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, {});
    expect(body.slice(body.indexOf("## What changed"), body.indexOf("## Tests"))).toMatch(/couldn't list/i);
    expect(body.slice(body.indexOf("## Tests"), body.indexOf("## Reviews"))).toMatch(/couldn't list|unknown/i);
    expect(body).toContain("## Risk: Medium");
  });

  it("names a failed check, a check that couldn't run and a review-only change in Tests", () => {
    const failing = workflowWith({
      stage: "VERIFY", state: "BLOCKED", blockReason: "candidate checks failed or have unknown results", reviews: undefined,
      checkPolicy: { required: [check("unit", "Unit tests"), check("lint", "Lint"), check("types", "Types")], optional: [], selectedOptionalIds: [], proposed: [] },
      verification: { candidateDigest: candidate("1").digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now,
        results: [{ checkId: "unit", status: "PASS" }, { checkId: "lint", status: "FAILED" }, { checkId: "types", status: "FAILED", programNotFound: true }] },
    });
    const tests = (() => { const body = workflowPullRequestBody(task, failing, planOf, SESSION, context()); return body.slice(body.indexOf("## Tests"), body.indexOf("## Reviews")); })();
    expect(tests).toMatch(/Failed:.*Lint/);
    expect(tests).toMatch(/Not checked:.*Types/);
    const reviewOnly = workflowWith({
      stage: "REVIEW", state: "WAITING", reviews: undefined,
      checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed: [], noneReason: "Documentation only" },
      verification: { candidateDigest: candidate("1").digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [], reviewOnly: true },
    });
    const body = workflowPullRequestBody(task, reviewOnly, planOf, SESSION, context());
    expect(body.slice(body.indexOf("## Tests"), body.indexOf("## Reviews"))).toContain("Documentation only");
    expect(body).toContain("## Risk: Medium");
  });

  it("says it checked against every check on the branch only when the base has no required checks", () => {
    const line = (base: string) => `Checked against every check on this branch, because ${base} has no required checks.`;
    expect(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ ciBasis: "all_checks", baseBranch: "main" }))).toContain(line("main"));
    expect(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ ciBasis: "all_checks" }))).toContain(line("the base branch"));
    expect(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ ciBasis: "required", baseBranch: "main" }))).not.toContain("Checked against every check");
    expect(workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context())).not.toContain("Checked against every check");
    // The line sits under Tests.
    const body = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ ciBasis: "all_checks", baseBranch: "main" }));
    expect(body.indexOf(line("main"))).toBeGreaterThan(body.indexOf("## Tests"));
    expect(body.indexOf(line("main"))).toBeLessThan(body.indexOf("## Reviews"));
    // A branch name is untrusted text.
    const odd = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ ciBasis: "all_checks", baseBranch: "@everyone/ghp_abcdefghijklmnopqrstuvwxyz0123456789" }));
    expect(odd).not.toContain("@everyone");
    expect(odd).not.toContain("ghp_");
  });

  it("shows the risk level with its reasons, from the files and the code reviewer's own level", () => {
    const sensitive = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context({ changedFiles: { files: [file("db/migrations/001.sql")], complete: true } }));
    expect(sensitive).toContain("## Risk: High");
    expect(sensitive.slice(sensitive.indexOf("## Risk:"), sensitive.indexOf(END))).toContain("db/migrations/001.sql");
    const reviewed = workflowWith({ reviews: workflowWith().reviews!.map((review) => review.role === "CRITIC" ? { ...review, risk: "high" } : review) });
    const body = workflowPullRequestBody(task, reviewed, planOf, SESSION, context());
    expect(body).toContain("## Risk: High");
    expect(body.slice(body.indexOf("## Risk:"), body.indexOf(END))).toMatch(/code review/i);
    // A review of other code doesn't count (the snapshot is at its review step, where that is allowed).
    const stale = workflowWith({ stage: "REVIEW", state: "WAITING", reviews: workflowWith().reviews!.map((review) => review.role === "CRITIC" ? { ...review, risk: "high", candidateDigest: candidate("2").digest } : review) });
    expect(workflowPullRequestBody(task, stale, planOf, SESSION, context())).toContain("## Risk: Low");
  });

  it("an accepted finding raises the risk and is listed under Reviews", () => {
    const finding = { text: "Retries can double-charge a card", origin: "INTRODUCED", severity: "HIGH", file: "src/retry.ts", line: 4 };
    const code = candidate("1");
    const accepted = workflowWith({
      reviews: [
        { operationId: randomUUID(), candidateDigest: code.digest, role: "CRITIC", provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now },
        { operationId: randomUUID(), candidateDigest: code.digest, role: "SECURITY", provider: "t", version: "1", status: "FINDINGS", findings: [finding], readOnly: true, recordedAt: now },
      ],
      acceptedFindings: [{ candidateDigest: code.digest, role: "SECURITY", fingerprint: workflowFindingFingerprint("SECURITY", finding), text: finding.text, reason: "Handled by the payment provider", actorId: ownerId, at: now }],
    });
    const body = workflowPullRequestBody(task, accepted, planOf, SESSION, context());
    expect(body).toContain("## Risk: High");
    const reviews = body.slice(body.indexOf("## Reviews"), body.indexOf("## Risk:"));
    expect(reviews).toContain("Owner accepted 1 review finding");
    expect(reviews).toContain("Retries can double-charge a card");
  });

  it("makes every model-written line inert: no mention, link, image, cross-reference, HTML or comment, and no secret", () => {
    const hostile = [
      "# Plan", "",
      "1. Ping @octocat and @org/team about https://evil.example/x and www.evil.example",
      "2. ![pixel](https://evil.example/p.png) [click me](javascript:alert(1)) <https://evil.example/auto>",
      "3. Fix #123 and org/repo#456 with <script>alert(1)</script> token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "4. <!-- an unclosed comment that would hide the rest",
      "5. <!-- /rovara:checks-and-reviews --> and <!-- rovara:checks-and-reviews -->",
    ].join("\n");
    const body = workflowPullRequestBody(task, workflowWith({
      checkPolicy: { required: [check("unit", "Unit @octocat <b>t</b> https://e.x/ghp_abcdefghijklmnopqrstuvwxyz0123456789")], optional: [], selectedOptionalIds: [], proposed: [] },
    }), hostile, SESSION, context({ changedFiles: { files: [file("src/@everyone.ts"), file("src/[x](http://evil.example).ts"), file("src/#12.ts")], complete: true } }));
    expect(body).not.toMatch(/@(?!‍)/u);
    expect(body).not.toContain("ghp_");
    expect(body).not.toMatch(/https?:\/\/(?!‍)[^\s]*evil/);
    expect(body).not.toMatch(/\]\(/);
    expect(body).not.toContain("<script");
    expect(body).not.toContain("<b>");
    expect(body).not.toMatch(/#(?!‍)\d/u);
    expect(body).not.toContain("<!-- an unclosed");
    expect(body).not.toMatch(/<!--(?! \/?rovara:checks-and-reviews -->)/);
    // The markers appear once each, so the block stays regenerable.
    expect(body.split(START)).toHaveLength(2);
    expect(body.split(END)).toHaveLength(2);
    expect(body).not.toMatch(/<(?!!-- \/?rovara:checks-and-reviews -->)/);
  });

  it("falls back to the task's title, made inert, when there is no plan", () => {
    const body = workflowPullRequestBody({ title: "Ping @octocat about <https://evil.example|this>" } as never, workflowWith(), undefined, SESSION, context());
    expect(body.split("\n")[0]).not.toMatch(/@(?!‍)/u);
    expect(body.split("\n")[0]).toContain("Ping");
  });

  it("stays under the byte cap whatever it is given, and keeps its markers, risk and closing line", () => {
    const longPlan = Array.from({ length: 400 }, (_, index) => `${index}. ${"A long plan sentence. ".repeat(40)}`).join("\n");
    const files = Array.from({ length: 200 }, (_, index) => file(`src/${"deep/".repeat(80)}file-${index}.test.ts`, 5, 5));
    const labels = Array.from({ length: 60 }, (_, index) => check(`c${index}`, `Check number ${index} ${"label ".repeat(10)}`));
    const findings = Array.from({ length: 20 }, (_, index) => ({ text: `Finding ${index} ${"text ".repeat(100)}`.slice(0, 600), origin: "PRE_EXISTING", severity: "LOW", file: `src/f${index}.ts`, line: 1 }));
    const code = candidate("1");
    const heavy = workflowWith({
      checkPolicy: { required: labels, optional: [], selectedOptionalIds: [], proposed: [] },
      verification: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: labels.map((item) => ({ checkId: item.id, status: "PASS" })) },
      reviews: [
        { operationId: randomUUID(), candidateDigest: code.digest, role: "CRITIC", provider: "t", version: "1", status: "PASS", findings, readOnly: true, recordedAt: now },
        { operationId: randomUUID(), candidateDigest: code.digest, role: "SECURITY", provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now },
      ],
      acceptedFindings: findings.map((finding) => ({ candidateDigest: code.digest, role: "CRITIC", fingerprint: workflowFindingFingerprint("CRITIC", finding), text: finding.text, reason: "r".repeat(500), actorId: ownerId, at: now })),
    });
    const body = workflowPullRequestBody(task, heavy, longPlan, SESSION, { changedFiles: { files, complete: true } });
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(30_000);
    expect(body.split(START)).toHaveLength(2);
    expect(body.split(END)).toHaveLength(2);
    expect(body).toContain("## Risk:");
    expect(body).toContain(`Rovara session: ${SESSION}`);
    expect(body.trimEnd().endsWith(CLOSING)).toBe(true);
    // A body that big can still be regenerated in place.
    expect(withStatusLines(body, ["- a new line"])).toBeDefined();
  });

  it("a pushed fix regenerates only the marked block: the person's words around it stay, and the risk is recomputed", () => {
    const first = workflowPullRequestBody(task, workflowWith(), planOf, SESSION, context());
    expect(first).toContain("## Risk: Low");
    const edited = `Heads up from Priya: please look at the retry cap first.\n\n${first}\n\nPS: merged after the standup.`;
    // A CI fix then touched infra/: another candidate, with its own diff.
    const fixed = workflowWith({ candidate: candidate("2"), reviews: workflowWith().reviews!.map((review) => ({ ...review, candidateDigest: candidate("2").digest })),
      verification: { candidateDigest: candidate("2").digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] } });
    const lines = workflowPullRequestStatusLines(fixed, context({ changedFiles: { files: [file("src/retry.ts"), file("infra/queue.ts")], complete: true } }));
    const next = withStatusLines(edited, lines);
    expect(next).toBeDefined();
    expect(next).toContain("Heads up from Priya: please look at the retry cap first.");
    expect(next).toContain("PS: merged after the standup.");
    expect(next).toContain("## Risk: High");
    expect(next).not.toContain("## Risk: Low");
    expect(next).toContain("infra/queue.ts");
    expect(next).toContain(`Rovara session: ${SESSION}`);
    expect(next).toContain(CLOSING);
    expect(next).toContain("Add the retry flag.");
    // Nothing else moved: putting the first lines back gives the first block again.
    const back = withStatusLines(next!, workflowPullRequestStatusLines(workflowWith(), context()));
    expect(back).toBe(edited);
  });
});

describe("which findings, reviews and recorded risk count", () => {
  const securityFinding = { text: "Retries can double-charge a card", origin: "INTRODUCED", severity: "HIGH", file: "src/retry.ts", line: 4 };
  const acceptedFor = (letter: string) => ({ candidateDigest: candidate(letter).digest, role: "SECURITY", fingerprint: workflowFindingFingerprint("SECURITY", securityFinding), text: securityFinding.text, reason: "ok", actorId: ownerId, at: now });

  it("only a finding accepted for this very code counts", () => {
    expect(recomputeRisk(workflowWith({ acceptedFindings: [acceptedFor("2")] }), context().changedFiles, {}).risk?.level).toBe("low");
    expect(recomputeRisk(workflowWith({ acceptedFindings: [acceptedFor("1")] }), context().changedFiles, {}).risk?.level).toBe("high");
  });

  it("a risk recorded for this code stands when the files can't be read now, and one recorded for other code does not", () => {
    const recorded = (letter: string) => ({ level: "high" as const, reasons: ["Changes sensitive paths: infra/main.ts."], candidateDigest: candidate(letter).digest });
    expect(workflowPullRequestBody(task, workflowWith({ risk: recorded("1") }), planOf, SESSION, {})).toContain("## Risk: High");
    const stale = workflowPullRequestBody(task, workflowWith({ risk: recorded("2") }), planOf, SESSION, {});
    expect(stale).toContain("## Risk: Medium");
    expect(stale).not.toContain("infra/main.ts");
  });

  it("an unclosed tag in a model-written line can't open a hidden comment", () => {
    const body = workflowPullRequestBody(task, workflowWith(), "<!-- hide the rest of the page\nSecond line", SESSION, context());
    expect(body).not.toContain("<!-- hide");
    expect(body.split("\n")[0]).toContain("&lt;!-- hide the rest of the page");
    expect(body.match(/<!--/g)).toHaveLength(2);
  });
});

describe("the risk is recomputed whenever the code on the pull request changes", () => {
  it("a CI fix touching infra/ recomputes the risk to high, for the new candidate", () => {
    const before = recomputeRisk(workflowWith(), context().changedFiles, {});
    expect(before.risk).toMatchObject({ level: "low", candidateDigest: candidate("1").digest });
    const fixed = workflowWith({ candidate: candidate("2"), risk: before.risk,
      reviews: workflowWith().reviews!.map((review) => ({ ...review, candidateDigest: candidate("2").digest })),
      verification: { candidateDigest: candidate("2").digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] } });
    const after = recomputeRisk(fixed, { files: [file("src/retry.ts"), file("infra/queue.ts")], complete: true }, {});
    expect(after.risk).toMatchObject({ level: "high", candidateDigest: candidate("2").digest });
    expect(WorkflowSnapshotSchema.safeParse(after).success).toBe(true);
  });

  it("uses the code reviewer's level and the owner's accepted findings for this candidate only", () => {
    const reviewed = workflowWith({ reviews: workflowWith().reviews!.map((review) => review.role === "CRITIC" ? { ...review, risk: "medium" } : review) });
    expect(recomputeRisk(reviewed, context().changedFiles, {}).risk?.level).toBe("medium");
  });

  it("a version 1 task shows no risk, however it is asked", () => {
    const v1 = workflowWith({}, "1.0.0");
    expect(recomputeRisk(v1, context().changedFiles, {})).toBe(v1);
    expect(recomputeRisk(v1, context().changedFiles, {})).not.toHaveProperty("risk");
  });
});

describe("a version 1 task's description is exactly as before", () => {
  it("keeps its title-free body, its AgentX task line and its closing line, and ignores a version 2 context", () => {
    const v1 = workflowWith({}, "1.0.0");
    const body = workflowPullRequestBody(task, v1, planOf, SESSION, undefined);
    const [summary, ...rest] = body.split("\n\n");
    expect(summary).toContain("Add the retry flag");
    expect(rest.join("\n\n")).toBe([
      "<!-- agentx:checks-and-reviews -->", "Checks: Unit tests passed", "Reviews: code review passed; security review passed", "<!-- /agentx:checks-and-reviews -->",
      `AgentX task: ${SESSION}`, "",
      "Opened as a draft by AgentX after the owner-approved plan, checks and reviews passed. Merge it on GitHub.",
    ].join("\n"));
    expect(body).toContain("<!-- agentx:checks-and-reviews -->");
    expect(body).toContain(`AgentX task: ${SESSION}`);
    expect(body).not.toContain("## ");
    expect(body).not.toContain("Rovara");
    // A context (version 2's) changes nothing on a version 1 task.
    expect(workflowPullRequestBody(task, v1, planOf, SESSION, context({ ciBasis: "all_checks", baseBranch: "main" }))).toBe(body);
    expect(workflowPullRequestStatusLines(v1, context())).toEqual(workflowPullRequestStatusLines(v1));
    expect(workflowPullRequestStatusLines(v1)).toEqual(["Checks: Unit tests passed", "Reviews: code review passed; security review passed"]);
  });
});

// ---- through the broker

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;
const operations = (harness: Harness, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
const passingChecks = () => ({ status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" });
const pullRequestGateway = () => ({
  reconcilePullRequest: vi.fn(async () => ({ number: 42, url: "https://github.com/example/demo/pull/42", reconciled: false })),
  getCommitTree: vi.fn(async () => "b".repeat(40)), getBranchHead: vi.fn(async () => "d".repeat(40)), getCommitParents: vi.fn(async () => ["e".repeat(40)]),
  verifyWebhookRepository: vi.fn(async () => true),
});
const DIFF = (files: string[]) => ["## demo", "", "### status", "### diff", ...files.flatMap((path) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1,3 @@", "-old", "+new", "+more", "+most"])].join("\n");

/** A task through its build: version 2 (its stored definition version set to 1.1.0, as the app will start it) or version 1. */
async function builtTask(definitionVersion: "1.0.0" | "1.1.0", diffFiles: string[] | undefined, diffText?: string) {
  const harness = await createDeveloperTaskBroker({ brokerExtra: { githubPullRequests: pullRequestGateway() } });
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
  const id = String((started.body.task as { taskId: string }).taskId);
  const record = () => harness.db.get(`DEVTASK#${id}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: WorkflowSnapshot };
  const workspaceId = record().workspaceId;
  harness.db.set({ ...record(), workflow: { ...record().workflow, definitionVersion, checkPolicy: { required: [{ id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] } } });
  await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } });
  const planning = operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN")!;
  const plan = "# Plan\n\n1. Fix retry handling.\n2. Add a regression test.\n";
  await finishPlanningWithMarkdown(harness, workspaceId, String(planning.id), plan);
  await harness.dev(MAYA, "POST", `/v1/dev/tasks/${id}/workflow/decision`, { requestId: randomUUID(), expectedRevision: record().workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: createHash("sha256").update(plan).digest("hex") });
  const implementation = operations(harness, workspaceId).find((item) => item.workflowMode === "IMPLEMENT")!;
  const built = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
  if (diffText !== undefined || diffFiles !== undefined) await harness.artifact(workspaceId, String(implementation.id), "workspace.diff", diffText ?? DIFF(diffFiles!));
  await harness.finish(workspaceId, String(implementation.id), "SUCCEEDED", { result: { workflowCandidateRepositories: built.repositories, workflowCheckCandidateRepositories: built.repositories, checks: passingChecks() } });
  const review = operations(harness, workspaceId).find((item) => item.workflowMode === "REVIEW")!;
  const reviewPayload = () => (harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === review.id)[0]?.invocation as { payload: Record<string, unknown> }).payload;
  const passReviews = (criticRisk?: string) => harness.finish(workspaceId, String(review.id), "SUCCEEDED", { result: { workflowCandidateRepositories: built.repositories,
    workflowReviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: review.id, candidateDigest: built.digest, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now,
      ...(role === "CRITIC" && criticRisk !== undefined ? { risk: criticRisk } : {}) })) } });
  const publication = () => operations(harness, workspaceId).find((item) => item.kind === "publish") as { publication: Record<string, unknown> } | undefined;
  return { harness, id, record, workspaceId, built, reviewPayload, passReviews, publication };
}

describe("a version 2 task through the broker", () => {
  it("asks the code review for a risk level, and a version 1 review is asked for none", async () => {
    expect((await builtTask("1.1.0", undefined)).reviewPayload().workflowReviewRisk).toBe(true);
    expect((await builtTask("1.0.0", undefined)).reviewPayload()).not.toHaveProperty("workflowReviewRisk");
  });

  it("opens the pull request titled Rovara, described in sections, with the risk recorded for the code it was judged on", async () => {
    const task = await builtTask("1.1.0", ["src/retry.ts", "src/retry.test.ts"]);
    await task.passReviews("medium");
    const publication = task.publication()!.publication;
    expect(String(publication.title)).toBe("Rovara: Fix the retry bug");
    const body = String(publication.body);
    for (const text of ["Fix retry handling.", "## What changed", "src/retry.ts (+3 -1)", "## Tests", "npm test", "Tests added: src/retry.test.ts", "## Reviews", "## Risk: Medium", "The code review rated this change medium risk.",
      "/review/", CLOSING]) expect(body, text).toContain(text);
    expect(body).not.toMatch(/agentx/i);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(30_000);
    expect(task.record().workflow.risk).toEqual({ level: "medium", reasons: ["The code review rated this change medium risk."], candidateDigest: task.built.digest });
    // The risk was recorded without moving the revision the publication was conditioned on.
    expect(WorkflowSnapshotSchema.safeParse(task.record().workflow).success).toBe(true);
  });

  it("a change to a sensitive path is high, whatever the reviewer says", async () => {
    const task = await builtTask("1.1.0", ["db/migrations/001.sql", "src/retry.ts"]);
    await task.passReviews("low");
    expect(String(task.publication()!.publication.body)).toContain("## Risk: High");
    expect(task.record().workflow.risk).toMatchObject({ level: "high" });
  });

  it("says the files couldn't be listed, and is at least medium, when the task left no diff", async () => {
    const task = await builtTask("1.1.0", undefined);
    await task.passReviews();
    const body = String(task.publication()!.publication.body);
    expect(body).toMatch(/couldn't list the changed files/);
    expect(body).toContain("## Risk: Medium");
  });

  const bigDiff = (extra: string) => `${DIFF(["src/retry.ts"])}\n${extra}`;
  for (const [name, content] of [
    ["a diff the worker cut", bigDiff("[workspace diff truncated to fit the AgentX artifact limit]")],
    ["a diff whose base commit is gone", bigDiff("[the commit this workspace was prepared at is not in this repository: the diff shows uncommitted changes only, not commits]")],
    ["a diff bigger than the broker reads", bigDiff(`+${"x".repeat(1_100_000)}`)],
    ["a diff that names as many files as diffStat keeps", DIFF(Array.from({ length: 200 }, (_, index) => `src/f${index}.ts`))],
  ] as const) {
    it(`is not low when the files come from ${name}`, async () => {
      const task = await builtTask("1.1.0", undefined, content);
      await task.passReviews();
      expect(task.record().workflow.risk?.level).toBe("medium");
      expect(task.record().workflow.risk?.reasons.join("\n")).toContain("couldn't list every changed file");
    });
  }

  it("is low only when the diff is whole", async () => {
    const task = await builtTask("1.1.0", ["src/retry.ts"]);
    await task.passReviews();
    expect(task.record().workflow.risk?.level).toBe("low");
  });

  it("a version 1 task keeps its title, its description and no risk", async () => {
    const task = await builtTask("1.0.0", ["db/migrations/001.sql"]);
    await task.passReviews();
    const publication = task.publication()!.publication;
    expect(String(publication.title)).toBe("AgentX: Fix the retry bug");
    const body = String(publication.body);
    expect(body).toContain("Checks: npm test passed");
    expect(body).toContain("Opened as a draft by AgentX after the owner-approved plan, checks and reviews passed. Merge it on GitHub.");
    expect(body).not.toContain("## ");
    expect(task.record().workflow).not.toHaveProperty("risk");
  });

  it("drops a risk level that a version 1 review reports", async () => {
    const task = await builtTask("1.0.0", undefined);
    await task.passReviews("high");
    expect(task.record().workflow.reviews?.find((review) => review.role === "CRITIC")).not.toHaveProperty("risk");
  });
});

describe("a pushed fix on a version 2 task", () => {
  const FIX_TREE = "c".repeat(40);
  const PUSHED = "f".repeat(40);
  const PR_URL = "https://github.com/example/demo/pull/42";

  /** The pull request is open with the first description; the fix (tree c) touching infra/ has just passed its checks and reviews. */
  async function fixPassed() {
    const state = { head: "d".repeat(40), tree: "b".repeat(40), body: "" };
    const branch = { name: "x" };
    const details = (number: number) => ({ number, url: PR_URL, state: "open" as const, headBranch: branch.name, baseBranch: "main", headCommit: state.head, title: "t", body: state.body });
    const gateway = {
      ...pullRequestGateway(),
      getPullRequest: vi.fn(async (_url: string, number: number) => details(number)),
      updatePullRequest: vi.fn(async (_url: string, number: number, change: { body?: string }) => { if (change.body !== undefined) state.body = change.body; return { ...details(number), state: "closed" as const }; }),
      getPullRequestFeedback: vi.fn(async (_url: string, number: number) => ({ pullRequest: { ...details(number), headTreeSha: state.tree }, comments: [], threads: [] })),
      getCommitParents: vi.fn(async (_url: string, commit: string) => [commit === state.head ? "e".repeat(40) : "d".repeat(40)]),
      getBranchHead: vi.fn(async () => state.head),
      getCommitTree: vi.fn(async (_url: string, commit: string) => commit === state.head ? state.tree : commit === PUSHED ? FIX_TREE : "b".repeat(40)),
    };
    const harness = await createDeveloperTaskBroker({ brokerExtra: { githubPullRequests: gateway } });
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const record = () => harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: WorkflowSnapshot };
    const workspaceId = record().workspaceId;
    harness.db.set({ ...record(), workflow: { ...record().workflow, definitionVersion: "1.1.0", checkPolicy: { required: [{ id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [] } } });
    await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } });
    const plan = "# Plan\n\n1. Fix retry handling.\n";
    await finishPlanningWithMarkdown(harness, workspaceId, String(operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN")!.id), plan);
    await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: record().workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: createHash("sha256").update(plan).digest("hex") });
    const implementation = operations(harness, workspaceId).find((item) => item.workflowMode === "IMPLEMENT")!;
    const first = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
    await harness.artifact(workspaceId, String(implementation.id), "workspace.diff", DIFF(["src/retry.ts"]));
    await harness.finish(workspaceId, String(implementation.id), "SUCCEEDED", { result: { workflowCandidateRepositories: first.repositories, workflowCheckCandidateRepositories: first.repositories, checks: passingChecks() } });
    const reviewOne = operations(harness, workspaceId).find((item) => item.workflowMode === "REVIEW")!;
    const reviews = (op: Record<string, unknown>, code: ReturnType<typeof createCandidateManifest>) => harness.finish(workspaceId, String(op.id), "SUCCEEDED", { result: { workflowCandidateRepositories: code.repositories,
      workflowReviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: op.id, candidateDigest: code.digest, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })) } });
    await reviews(reviewOne, first);
    const publish = operations(harness, workspaceId).find((item) => item.kind === "publish") as { id: string; publication: { repository: string; repositoryUrl: string; headBranch: string; baseBranch: string; title: string; body?: string } };
    const p = publish.publication;
    branch.name = p.headBranch;
    state.body = `A note from Priya, kept.\n\n${p.body}`;
    await harness.callback(workspaceId, publish.id, "pull-request", { repository: p.repository, repositoryUrl: p.repositoryUrl, headBranch: p.headBranch, baseBranch: p.baseBranch, commit: "d".repeat(40), title: p.title, ...(p.body === undefined ? {} : { body: p.body }) });
    await harness.finish(workspaceId, publish.id, "SUCCEEDED", { result: { repository: "demo", number: 42, url: PR_URL, headBranch: p.headBranch, baseBranch: "main", commit: "d".repeat(40), checks: [], reconciled: false } });
    expect(record().workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", risk: { level: "low", candidateDigest: first.digest } });
    // The fix: another candidate, whose coding operation left a diff that touches infra/. Its reviews are due.
    const fix = createCandidateManifest([{ repositoryId: "demo", commitSha: PUSHED, treeSha: FIX_TREE, baseCommitSha: "e".repeat(40) }]);
    const opened = record();
    const reviewing = WorkflowSnapshotSchema.parse({ ...opened.workflow, revision: opened.workflow.revision + 1, stage: "REVIEW", state: "WAITING", candidate: fix, reviews: [],
      verification: { candidateDigest: fix.digest, producer: "t", environmentId: "w", recordedAt: now, results: [{ checkId: "required-1", status: "PASS" }] }, updatedAt: now });
    harness.db.set({ ...opened, workflow: reviewing });
    harness.db.set((workflowDispatchItem("state", taskId, reviewing.revision, "REVIEW", fix.digest, now).Put as { Item: Record<string, unknown> }).Item);
    await harness.handler({ source: "agentx.workflow-dispatch-recovery" });
    const reviewTwo = operations(harness, workspaceId).filter((item) => item.workflowMode === "REVIEW").at(-1)!;
    await harness.artifact(workspaceId, String(reviewTwo.id), "workspace.diff", DIFF(["src/retry.ts", "infra/queue.ts"]));
    return { harness, gateway, state, taskId, workspaceId, record, first, fix, finishReviews: () => reviews(reviewTwo, fix), opened: String(p.body) };
  }

  it("judges the risk again for the new code in the write that starts the push, and the description's block follows the push", async () => {
    const t = await fixPassed();
    await t.finishReviews();
    const maintain = operations(t.harness, t.workspaceId).find((item) => item.kind === "maintain") as { id: string; maintenance: { headBranch: string } };
    expect(maintain).toBeDefined();
    // The push started: the workflow already holds the risk of the code it is pushing.
    expect(t.record().workflow.risk).toMatchObject({ level: "high", candidateDigest: t.fix.digest });
    expect(t.record().workflow.risk?.reasons.join("\n")).toContain("infra/queue.ts");
    // Until the push lands the pull request still shows the first code and its first risk.
    expect(t.state.body).toContain("## Risk: Low");
    t.state.head = PUSHED;
    t.state.tree = FIX_TREE;
    await t.harness.callback(t.workspaceId, maintain.id, "pull-request-update", { repository: "demo", pullRequestNumber: 42, action: "append", headBranch: maintain.maintenance.headBranch, baseBranch: "main", previousCommit: "d".repeat(40), commit: PUSHED });
    await t.harness.finish(t.workspaceId, maintain.id, "SUCCEEDED", { result: { action: "append", repository: "demo", number: 42, url: PR_URL, state: "open", headBranch: maintain.maintenance.headBranch, baseBranch: "main",
      previousCommit: "d".repeat(40), commit: PUSHED, treeSha: FIX_TREE, checks: [], reconciled: false } });
    expect(t.record().workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", risk: { level: "high", candidateDigest: t.fix.digest } });
    expect(t.gateway.updatePullRequest).toHaveBeenCalled();
    expect(t.state.body).toContain("A note from Priya, kept.");
    expect(t.state.body).toContain("## Risk: High");
    expect(t.state.body).not.toContain("## Risk: Low");
    expect(t.state.body).toContain("infra/queue.ts");
    expect(t.state.body).toContain(CLOSING);
    expect(t.state.body.split(START)).toHaveLength(2);
  });
});
