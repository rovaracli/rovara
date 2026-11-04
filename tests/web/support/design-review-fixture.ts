// Design review (DR11): a stored review as the task view carries it, with hostile model words in the places a model writes, and a task page built from it.
import { WorkflowDesignReviewSchema, designFindingFingerprint, type DesignReviewView, type ReviewerRole } from "@agentx/contracts/web";
import { sessionFixture, taskFixture } from "./session-fixture.js";
import { workspaceWorkflow } from "./workspace-fixture.js";

export const HOSTILE = "<script>window.__pwned=1</script> [click me](https://evil.example/steal) <img src=x onerror=alert(1)> ‮gnp.exe⁦ **bold**";
/** The same words without the hidden characters: fields the contract holds to "plain text" (a note, a file name, a question) refuse them, so a hostile model can only put markup and links there. */
export const HOSTILE_PLAIN = HOSTILE.replace(/[\u202E\u2066]/gu, "");
const hex = (character: string) => character.repeat(64);
const NOW = "2026-11-03T10:00:00.000Z";

function run(role: ReviewerRole, overrides: Record<string, unknown> = {}) {
  return {
    role, promptId: `design-review-${role}`, promptVersion: 1, promptDigest: hex("a"), model: { provider: "anthropic", modelId: "claude-opus-5-5" }, sourceId: "src-1", sessionId: `sess-${role}`, modelKeyId: `key-${role}`,
    packetDigest: hex("b"), packet: [{ kind: "repo_file", ref: "acme/payments:src/retry.ts", commitOrFetchedAt: "1234567890abcdef1234567890abcdef12345678", digest: hex("c"), bytes: 100 }], filesRead: ["src/retry.ts", HOSTILE_PLAIN],
    verified: true, inputProof: "digest_only", tokensIn: 12000, tokensOut: 1500, costUsd: 0.32, startedAt: NOW, endedAt: NOW, ...overrides,
  };
}
function finding(id: string, severity: "blocker" | "major" | "nit", section: string, text: string, roles: ReviewerRole[], citations: unknown[]) {
  const rawFindings = roles.map((role, index) => ({ rawId: `${id}-r${String(index)}`, role, severity, text }));
  return { id, severity, section, text, citations, fromReviewers: roles, rawIds: rawFindings.map((raw) => raw.rawId), rawFindings, fingerprint: designFindingFingerprint({ section, text, rawFindings }) };
}

/** A finished review: a blocker the planner contested (hostile words), a major it says it fixed, a nit nobody answered, one question, and a paraphrase. */
export function designReviewFixture(overrides: Record<string, unknown> = {}): DesignReviewView {
  const blocker = finding("f1", "blocker", "§3", HOSTILE, ["critic", "codebase"], [
    { kind: "design", section: "§3" },
    { kind: "code", repo: "acme/payments", path: "src/retry.ts", startLine: 10, endLine: 14, anchor: "retry loop", commit: "1234567" },
    { kind: "code", repo: "acme/payments", path: "src/never-opened.ts", startLine: 3, endLine: 3, anchor: "elsewhere", commit: "1234567" },
  ]);
  const major = finding("f2", "major", "§2", "The current system section leaves out the queue.", ["critic"], [{ kind: "design", section: "§2" }]);
  const nit = finding("f3", "nit", "§1", "Name the goal in one sentence.", ["comprehension"], [{ kind: "design", section: "§1" }]);
  return WorkflowDesignReviewSchema.parse({
    decidedBy: "auto", reasons: ["new_api", "data_model"], note: HOSTILE_PLAIN, status: "done", tier: "standard", estimateUsd: 1.1, spentUsd: 0.96, capUsd: 10,
    rounds: [{
      round: 1, designDigest: hex("d"),
      reviewers: [
        run("comprehension", { paraphrase: HOSTILE, inputProof: "proxy_first_call" }), run("critic"),
        run("codebase", { verified: false, inputProof: undefined, verifyFailure: "packet_digest_mismatch" }),
      ],
      findings: [blocker, major, nit],
      resolutions: [
        { findingId: "f1", action: "contested", evidence: [{ kind: "design", section: "§4" }], note: HOSTILE, settled: false },
        { findingId: "f2", action: "fixed", note: "Added the queue to section 2.", settled: true },
      ],
      questions: [{ id: "q1", unclear: HOSTILE_PLAIN.slice(0, 190), evidence: [{ kind: "design", section: "§3" }], options: [{ id: "a", label: "Exclude them", consequence: "Rows with no region drop out." }, { id: "b", label: "Default to global", consequence: "Keeps today's ranking." }], recommended: "b", why: "Keeps today's ranking for those rows." }],
    }],
    ...overrides,
  });
}

/** The session the task page reads: a Full-path task with the review on its workflow. */
export function designTaskSession(review: DesignReviewView | undefined, task: Record<string, unknown> = {}, workflow: Record<string, unknown> = {}) {
  const body = taskFixture({ workflow: { ...workspaceWorkflow(), definitionVersion: "1.1.0", path: "FULL", reviewPhase: "DESIGN", ...(review === undefined ? {} : { designReview: review }), ...workflow }, ...task });
  return sessionFixture({ kind: "task", status: "waiting", step: "Design review", where: { kind: "cloud" }, body: { kind: "task", task: body } });
}
