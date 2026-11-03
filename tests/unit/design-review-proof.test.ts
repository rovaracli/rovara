// Design review stage, DR12 (design-review-stage.md 1.2, 3.10, 3.11; owner Q8, Q9): design links in the Proof rows, the one design line of the pull request, and the approved design in the spec write-back.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INPUT_PROOF_SENTENCES, SpecDraftSchema, SpecTargetSchema, WorkflowDesignReviewSchema, type ReviewerRole, type WorkflowDesignReview } from "../../packages/contracts/src/index.js";
import { designApprovalProofLine } from "../../packages/broker/src/design-review/approve-handler.js";
import { loadProofDesignContext } from "../../packages/broker/src/design-review/proof-context.js";
import { designProofFacts, designProofLine, designReviewedLine, openBlockerWords, type DesignProofApproval, type ProofDesignContext } from "../../packages/broker/src/design-review/proof-line.js";
import { designLinksByClaim, designSubsections, designTextDigest, proseNamesRequirement } from "../../packages/broker/src/design-review/proof-links.js";
import { PROOF_LEVEL_LAST, proofSection } from "../../packages/broker/src/rovara-code/proof-section.js";
import { loadProofContext } from "../../packages/broker/src/rovara-code/proof-inputs.js";
import { acceptSpecWrite } from "../../packages/broker/src/spec/accept-draft.js";
import { approvedDesignDigestOf, specDesignMarkdown, specDesignState } from "../../packages/broker/src/spec/approved-design.js";
import { specOperationEndItems, type SpecEndEnvironment } from "../../packages/broker/src/spec/end-items.js";
import { createSpecHooks, type SpecWorld } from "../../packages/broker/src/spec/hooks.js";
import { specPullRequestBody } from "../../packages/broker/src/spec/link.js";
import { newSpecState, startWriting, type SpecState } from "../../packages/broker/src/spec/state.js";
import { DESIGN_TEXT, proofPlan, proofWorkflow } from "../support/design-review-proof-fixtures.js";

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const DIGEST = sha(DESIGN_TEXT);
const APPROVED = { digest: DIGEST, text: DESIGN_TEXT };
const FINDING_TEXT = "FINDING-TEXT-7731 the retry queue loses messages on restart";
const REASON = "the queue loss is tracked in the follow-up and the pilot has no restarts";
const NOW = "2026-11-03T10:00:00.000Z";

function run(role: ReviewerRole, extra: Record<string, unknown> = {}) {
  return {
    role, promptId: `design-${role}`, promptVersion: 1, promptDigest: "c".repeat(64), model: { provider: "bedrock", modelId: "m" }, sourceId: "s", sessionId: `session-${role}`, modelKeyId: `key-${role}`,
    packetDigest: "d".repeat(64), packet: [], filesRead: [], verified: true, inputProof: "digest_only", tokensIn: 10, tokensOut: 5, costUsd: 0.1, startedAt: NOW, endedAt: NOW, ...extra,
    ...(role === "comprehension" ? { paraphrase: "PARAPHRASE-TEXT-2208 proposes a queue" } : {}),
  };
}
function reviewOf(runs: Array<Record<string, unknown>> = [run("comprehension"), run("critic"), run("codebase")], extra: Record<string, unknown> = {}): WorkflowDesignReview {
  return WorkflowDesignReviewSchema.parse({
    decidedBy: "auto", reasons: ["new_api"], status: "done", tier: "standard", spentUsd: 0.9,
    rounds: [{
      round: 1, designDigest: DIGEST, reviewers: runs,
      findings: [{ id: "f1", severity: "blocker", section: "§3", text: FINDING_TEXT, citations: [{ kind: "design", section: "§3" }], fromReviewers: ["critic"], rawIds: ["critic-1"], fingerprint: "e".repeat(64) }],
      resolutions: [],
    }],
    ...extra,
  });
}
const approval = (extra: Partial<DesignProofApproval> = {}): DesignProofApproval => ({ approverLabel: "Priya", tier: "high", openBlockers: 0, ...extra });
const context = (extra: Partial<ProofDesignContext> = {}): ProofDesignContext => ({ approved: APPROVED, review: reviewOf(), approval: approval(), ...extra });
const textOf = (design: ProofDesignContext | undefined, level = 0): string => proofSection(proofWorkflow(), { plan: proofPlan(), ...(design === undefined ? {} : { design }) })!(level).join("\n");

describe("design links in the Proof rows", () => {
  it("finds the §3 subsections that exist, and the claims they name outside code fences", () => {
    expect(designSubsections(DESIGN_TEXT).map((section) => section.id)).toEqual(["§3.1", "§3.2", "§3.3"]);
    const links = designLinksByClaim(["1", "1.1", "2", "3", "9"], APPROVED);
    // "1" is written R1 (and is not found in R1.1's sentence only), R2 appears in §3.2 and again outside §3 (not a link), R3 only in a fence, R9 nowhere.
    expect(Object.fromEntries(links)).toEqual({ "1": ["§3.1"], "1.1": ["§3.1"], "2": ["§3.2"] });
  });

  it("links only to a section that exists: a §3.9 named in prose, or a made-up number, is never a link", () => {
    expect([...designLinksByClaim(["2"], APPROVED).values()].flat()).not.toContain("§3.9");
    const text = "## 3. Proposed design\n### 3.1 A\nR1 here. See §3.7.\n#### 3.1.2 Deeper\nR2 here.\n### 33.1 Not three\nR3 here.\n### 4.2 Elsewhere\nR4 here.";
    const links = designLinksByClaim(["1", "2", "3", "4"], { digest: sha(text), text });
    // 3.1.2 is inside 3.1 (a deeper heading does not close it); 33.1 and 4.2 are not §3 subsections, so R3 and R4 stay unlinked.
    expect(Object.fromEntries(links)).toEqual({ "1": ["§3.1"], "2": ["§3.1"] });
  });

  it("gives no link when the text is not the approved digest (a revised or swapped design)", () => {
    expect(designLinksByClaim(["1", "2"], { digest: sha("another design"), text: DESIGN_TEXT }).size).toBe(0);
    expect(designLinksByClaim(["1"], undefined).size).toBe(0);
    expect(designLinksByClaim(["1"], { digest: "nothex", text: DESIGN_TEXT }).size).toBe(0);
    expect(designTextDigest(DESIGN_TEXT)).toBe(DIGEST);
  });

  it("matches a whole requirement id only", () => {
    expect(proseNamesRequirement("R1.2 is covered", "1")).toBe(false);
    expect(proseNamesRequirement("R10 is covered", "1")).toBe(false);
    expect(proseNamesRequirement("AR1 is covered", "1")).toBe(false);
    expect(proseNamesRequirement("(R1), and R1.", "1")).toBe(true);
    expect(proseNamesRequirement("sections 1 and 2", "1")).toBe(false);
    expect(proseNamesRequirement("REQ-4 is covered", "REQ-4")).toBe(true);
  });

  it("puts 'design §3.x' on the row of a covered requirement and leaves other rows as they were", () => {
    const text = textOf(context());
    expect(text).toMatch(/\| 1: Payments that time out are retried\. \| design §3\.1; Unit tests \(passed\) \| ✅ passed \|/u);
    expect(text).toMatch(/\| 1\.1: [^|]*\| design §3\.1; Unit tests \(passed\) \|/u);
    expect(text).toMatch(/\| 2: A payment is never charged twice\. \| design §3\.2; Lint \(passed\) \| ✅ passed \|/u);
    // Claim 3 appears in the design only inside a code fence: no link, the row is unchanged.
    expect(text).toContain("| 3: The retry count is shown on the payment page. | none | ⚠ not tested |");
    for (let level = 0; level <= PROOF_LEVEL_LAST; level += 1) for (const line of textOf(context(), level).split("\n").filter((entry) => entry.includes("design §"))) expect(line).not.toContain("§3.9");
  });

  it("drops every link when the approved text does not hash to the approved digest", () => {
    const text = textOf(context({ approved: { digest: sha("other"), text: DESIGN_TEXT } }));
    expect(text).not.toContain("design §");
  });
});

describe("the Proof line about design review", () => {
  it("states coverage, the fixed input-proof sentence, the approver and the tier, and no finding text", () => {
    const line = designProofLine(context());
    expect(line).toBe(`Design review: coverage all (3 of 3 reviewers, 1 round), ${INPUT_PROOF_SENTENCES.digest_only}. Approved by Priya (high risk).`);
    for (const secret of [FINDING_TEXT, "FINDING-TEXT-7731", "PARAPHRASE-TEXT-2208", "session-critic", "key-critic"]) expect(textOf(context())).not.toContain(secret);
    expect(designProofLine(context({ approval: approval({ openBlockers: 0 }) }))).not.toContain("blocker");
  });

  it("says proxy-confirmed only when every verified reviewer was; one digest-only run makes the whole line digest-only", () => {
    const proxy = [run("comprehension", { inputProof: "proxy_first_call" }), run("critic", { inputProof: "proxy_first_call" }), run("codebase", { inputProof: "proxy_first_call" })];
    expect(designProofLine(context({ review: reviewOf(proxy) }))).toContain(INPUT_PROOF_SENTENCES.proxy_first_call);
    const mixed = [run("comprehension", { inputProof: "proxy_first_call" }), run("critic"), run("codebase", { inputProof: "proxy_first_call" })];
    const line = designProofLine(context({ review: reviewOf(mixed) }));
    expect(line).toContain(INPUT_PROOF_SENTENCES.digest_only);
    expect(line).not.toContain(INPUT_PROOF_SENTENCES.proxy_first_call);
  });

  it("coverage is partial when a reviewer was voided and none when nobody was verified or no review ran", () => {
    const voided = run("codebase", { verified: false, verifyFailure: "packet_digest_mismatch", inputProof: undefined });
    expect(designProofFacts(reviewOf([run("comprehension"), run("critic"), voided]))).toMatchObject({ coverage: "partial", planned: 3, verified: 2 });
    expect(designProofLine(context({ review: reviewOf([run("comprehension"), run("critic"), voided]) }))).toContain("coverage partial (2 of 3 reviewers");
    const none = reviewOf([run("critic", { verified: false, verifyFailure: "timeout", inputProof: undefined })]);
    expect(designProofLine(context({ review: none }))).toMatch(/^Design review: no reviewer was verified\. Approved by Priya \(high risk\)\.$/u);
    expect(designProofLine(context({ review: undefined }))).toMatch(/^Design review: no reviewer was verified\./u);
    expect(designProofFacts(undefined).coverage).toBe("none");
  });

  it("adds the one-line reason only when blockers were open (Q8), and it equals the approval handler's words", () => {
    const withReason = designProofLine(context({ approval: approval({ openBlockers: 1, reason: REASON }) }));
    expect(withReason.endsWith(`Design approved with 1 open blocker: ${REASON}`)).toBe(true);
    expect(openBlockerWords(2, REASON)).toBe(designApprovalProofLine(2, REASON));
    expect(openBlockerWords(1, REASON)).toBe(designApprovalProofLine(1, REASON));
    expect(openBlockerWords(0, REASON)).toBeUndefined();
    // A reason with nothing recorded is said plainly, never invented.
    expect(designProofLine(context({ approval: approval({ openBlockers: 2 }) }))).toContain("Design approved with 2 open blockers; no reason was recorded.");
    // The reason is a person's words: made inert for GitHub, cut, and never carries the finding.
    const hostile = designProofLine(context({ approval: approval({ openBlockers: 1, reason: "ping @everyone <!-- hide --> see #123 and https://evil.example\nsecond line" }) }));
    expect(hostile).not.toMatch(/@everyone|<!--|\n/u);
    expect(hostile).not.toContain(FINDING_TEXT);
  });

  it("the PR carries the line exactly once, above the table, and keeps it at every shrink level", () => {
    for (let level = 0; level <= PROOF_LEVEL_LAST; level += 1) {
      const lines = textOf(context(), level).split("\n");
      expect(lines.filter((line) => line.startsWith("Design review:")), `level ${level}`).toHaveLength(1);
      expect(lines.indexOf(lines.find((line) => line.startsWith("Design review:"))!)).toBeLessThan(lines.findIndex((line) => line.startsWith("| Requirement")));
    }
  });
});

describe("OFF: no design review leaves the Proof output byte for byte as it was", () => {
  const golden = JSON.parse(readFileSync(new URL("../fixtures/design-review-proof-off-golden.json", import.meta.url), "utf8")) as Record<string, string[]>;
  it("matches the output recorded before DR12, at every level, with and without a result label", () => {
    expect(Object.keys(golden)).toHaveLength(2 * (PROOF_LEVEL_LAST + 1));
    for (const [name, label] of [["plain", undefined], ["labelled", "Passed"]] as const) {
      for (let level = 0; level <= PROOF_LEVEL_LAST; level += 1) {
        expect(proofSection(proofWorkflow(), { plan: proofPlan() }, label)!(level), `${name}:${level}`).toEqual(golden[`${name}:${level}`]);
        expect(proofSection(proofWorkflow(), { plan: proofPlan(), design: undefined }, label)!(level), `${name}:${level} (design: undefined)`).toEqual(golden[`${name}:${level}`]);
      }
    }
  });

  it("loadProofContext without a design port, or with a failing one, has no design key", async () => {
    const actions = {} as never;
    const approvedPlan = { format: "structured", plan: proofPlan() } as never;
    const without = await loadProofContext({ actions }, { ownerKey: "o", workspaceId: "w" }, proofWorkflow(), approvedPlan, []);
    expect(without).not.toHaveProperty("design");
    const failing = await loadProofContext({ actions, design: async () => { throw new Error("boom"); } }, { ownerKey: "o", workspaceId: "w" }, proofWorkflow(), approvedPlan, []);
    expect(failing).not.toHaveProperty("design");
    const given = await loadProofContext({ actions, design: async () => context() }, { ownerKey: "o", workspaceId: "w" }, proofWorkflow(), approvedPlan, []);
    expect(given?.design).toEqual(context());
  });
});

describe("the design context is built only from an approved design", () => {
  const artifact = { id: "d1", type: "design" as const, version: 1, sha256: DIGEST, producer: "p", objectKey: "k", createdAt: NOW };
  const decision = (extra: Record<string, unknown> = {}) => ({ requestId: "1b4e28ba-2fa1-11d2-883f-0016d3cca427", workflowRevision: 3, decision: "APPROVE", actorId: "priya", actorRole: "TASK_OWNER", reason: "ok", artifactDigest: DIGEST, at: NOW, ...extra });
  const workflowOf = (extra: Record<string, unknown>) => ({ ...proofWorkflow(), artifacts: [artifact], decisions: [decision()], designReview: reviewOf(), ...extra }) as never;
  const ports = { designText: async () => DESIGN_TEXT, approval: async () => approval() };

  it("builds the context for the approved digest", async () => {
    expect(await loadProofDesignContext(ports, workflowOf({}))).toMatchObject({ approved: APPROVED, approval: { approverLabel: "Priya" } });
  });
  it("builds nothing when design review is off, nothing is approved, only the broker 'approved', the text is not the approved one, or no approval is recorded", async () => {
    expect(await loadProofDesignContext(ports, workflowOf({ designReview: undefined }))).toBeUndefined();
    expect(await loadProofDesignContext(ports, workflowOf({ decisions: [] }))).toBeUndefined();
    expect(await loadProofDesignContext(ports, workflowOf({ decisions: [decision({ actorRole: "AGENTX" })] }))).toBeUndefined();
    expect(await loadProofDesignContext(ports, workflowOf({ decisions: [decision({ artifactDigest: "9".repeat(64) })] }))).toBeUndefined();
    expect(await loadProofDesignContext({ ...ports, designText: async () => "a revised design" }, workflowOf({}))).toBeUndefined();
    expect(await loadProofDesignContext({ ...ports, designText: async () => undefined }, workflowOf({}))).toBeUndefined();
    expect(await loadProofDesignContext({ ...ports, approval: async () => undefined }, workflowOf({}))).toBeUndefined();
  });
});

describe("the approved design in the spec write-back", () => {
  const artifact = { id: "d1", type: "design" as const, version: 1, sha256: DIGEST, producer: "p", objectKey: "k", createdAt: NOW };
  const approvedDecision = { requestId: "1b4e28ba-2fa1-11d2-883f-0016d3cca427", workflowRevision: 3, decision: "APPROVE", actorId: "priya", actorRole: "TASK_OWNER", reason: "ok", artifactDigest: DIGEST, at: NOW };
  const wf = (extra: Record<string, unknown> = {}) => ({ artifacts: [artifact], decisions: [approvedDecision], designReview: reviewOf(), ...extra }) as never;

  it("approvedDesignDigestOf needs a person's approval of the LATEST design", () => {
    expect(approvedDesignDigestOf(wf())).toBe(DIGEST);
    expect(approvedDesignDigestOf(wf({ decisions: [] }))).toBeUndefined();
    expect(approvedDesignDigestOf(wf({ decisions: [{ ...approvedDecision, actorRole: "AGENTX" }] }))).toBeUndefined();
    // A newer design (sent back and revised) is not approved by the older approval.
    expect(approvedDesignDigestOf(wf({ artifacts: [artifact, { ...artifact, id: "d2", version: 2, sha256: sha("v2") }] }))).toBeUndefined();
  });

  it("is off with no design review, waits until a design is approved, and approves only text that hashes to the approved digest", () => {
    expect(specDesignState(wf({ designReview: undefined }), () => DESIGN_TEXT)).toEqual({ kind: "off" });
    expect(specDesignState(wf({ decisions: [] }), () => DESIGN_TEXT)).toEqual({ kind: "wait" });
    expect(specDesignState(wf(), () => DESIGN_TEXT)).toEqual({ kind: "approved", design: APPROVED });
    expect(specDesignState(wf(), () => "a revised design")).toEqual({ kind: "wait" });
    expect(specDesignState(wf(), () => undefined)).toEqual({ kind: "wait" });
    expect(specDesignState(wf(), () => { throw new Error("unreadable"); })).toEqual({ kind: "wait" });
    // A review that never ran and has no design document has nothing to wait for.
    expect(specDesignState(wf({ artifacts: [], decisions: [], designReview: reviewOf([], { status: "not_run", notRunReason: "no_model_source", rounds: [] }) }), () => undefined)).toEqual({ kind: "off" });
  });

  const PLAN = "a".repeat(64);
  const BASE = "b".repeat(40);
  const draft = (design: string) => SpecDraftSchema.parse({
    version: 1, kind: "feature", title: "Retry failed payments", summary: "Retries.", planDigest: PLAN, design,
    requirements: [{ title: "Retry", criteria: [{ when: "a payment times out", shall: "retry it" }] }], tasks: [{ title: "Add the queue", covers: ["1.1"] }],
  });
  const stateOf = (format: string): SpecState => newSpecState({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", planDigest: PLAN, kind: "feature", target: SpecTargetSchema.parse({ format, ...(format === "team_template" ? { templatePath: "templates/spec" } : {}) }), knowledgeCommit: BASE, now: NOW });
  const accept = (format: string, design: Parameters<typeof acceptSpecWrite>[0]["design"], modelDesign = "MODEL-DESIGN-TEXT") => acceptSpecWrite({
    result: { specDraft: draft(modelDesign) }, state: stateOf(format), approvedPlanDigest: PLAN, taskKey: "T-1", existingFolders: [],
    ...(format === "team_template" ? { template: [{ path: "spec.md", content: "# Spec\n\n## Summary\n\n## Requirements\n\n## Design\n\n## Tasks\n" }] } : {}),
    ...(design === undefined ? {} : { design }),
  });

  it("writes only the approved design's text, converted for every shipped format, with no finding text", () => {
    for (const format of ["kiro", "speckit", "rovara", "team_template"]) {
      const accepted = accept(format, { kind: "approved", design: APPROVED });
      expect(accepted.ok, format).toBe(true);
      if (!accepted.ok) continue;
      const all = accepted.files.map((file) => file.content).join("\n");
      expect(all, format).toContain(`Approved design (digest ${DIGEST.slice(0, 12)}).`);
      expect(all, format).toContain("Retry queue");
      expect(all, format).toContain("R2 is met by a key per charge");
      // The model's own design wording is replaced, never added beside it.
      expect(all, format).not.toContain("MODEL-DESIGN-TEXT");
      for (const secret of [FINDING_TEXT, "FINDING-TEXT-7731", "PARAPHRASE-TEXT-2208", "session-critic", "key-critic", REASON]) expect(all, `${format} ${secret}`).not.toContain(secret);
    }
  });

  it("the converter takes the design text alone: headings become bold lines and markup is neutralised", () => {
    const text = "## 3. Proposed design\n### 3.1 A\nSee [link](https://evil.example) and <script>x</script> @everyone";
    const markdown = specDesignMarkdown({ digest: sha(text), text })!;
    expect(markdown).toContain("**3.1 A**");
    expect(markdown).not.toMatch(/<script>|\]\(https/u);
    expect(specDesignMarkdown({ digest: sha("else"), text })).toBeUndefined();
    expect(specDesignMarkdown({ digest: DIGEST, text: "x".repeat(60_000) })).toBeUndefined();
    const big = "word ".repeat(11_000);
    expect(specDesignMarkdown({ digest: sha(big), text: big })).toBeUndefined();
  });

  it("OFF leaves the spec exactly as it was: the model's design stays, and off / absent give the same files", () => {
    const absent = accept("kiro", undefined);
    const off = accept("kiro", { kind: "off" });
    expect(off).toEqual(absent);
    expect(absent.ok && absent.files.map((file) => file.content).join("\n")).toContain("MODEL-DESIGN-TEXT");
  });

  it("nothing is written before approval: a waiting state writes no files, and the gate does not start a write", async () => {
    expect(accept("kiro", { kind: "wait" })).toEqual({ ok: false, code: "write_failed" });

    let started = 0;
    const saved: SpecState[] = [];
    const state = stateOf("kiro");
    const world = {
      tableName: "t", now: () => NOW, log: () => undefined,
      store: { load: async () => ({ state: saved.at(-1) ?? state, corrupt: false }), save: async (next: SpecState) => { saved.push(next); return true; }, force: async () => true },
      startWrite: async () => { started += 1; return "STARTED" as const; },
      publish: async () => ({ ok: false as const, transient: true }),
    } as unknown as SpecWorld;
    const input = { task: { taskId: state.taskId, title: "T", knowledgeCommit: BASE }, approvedPlanDigest: PLAN, planMarkdown: () => "# Plan", metaRepositoryUrl: undefined };
    const waiting = await createSpecHooks(world).gate({ ...input, design: async () => ({ kind: "wait" }) });
    expect(waiting).toMatchObject({ proceed: false, hold: { action: "hold", reason: "waiting_approval" } });
    expect(started).toBe(0);
    const broken = await createSpecHooks(world).gate({ ...input, design: async () => { throw new Error("x"); } });
    expect(broken).toMatchObject({ proceed: false });
    expect(started).toBe(0);
    await createSpecHooks(world).gate({ ...input, design: async () => ({ kind: "approved", design: APPROVED }) });
    expect(started).toBe(1);
  });

  it("the end of the write uses the approved design, and a waiting or failing design fails the write instead of publishing", async () => {
    const OPERATION = "6fa459ea-ee8a-3ca4-894e-db77e160355e";
    const state = startWriting(stateOf("kiro"), OPERATION, NOW)!;
    const written: unknown[] = [];
    const env = (design?: SpecEndEnvironment["design"]): SpecEndEnvironment => ({
      tableName: "t",
      store: { load: async () => ({ state, corrupt: false }), save: async () => true, force: async () => true },
      now: () => NOW, approvedPlanDigest: async () => PLAN, taskKey: () => "T-1", existingFolders: async () => [], template: async () => undefined, forbiddenFolders: async () => [], republishItem: async () => undefined,
      ...(design === undefined ? {} : { design }),
    });
    const outcome = { status: "SUCCEEDED", result: { specDraft: draft("MODEL-DESIGN-TEXT") } };
    const ok = await specOperationEndItems(env(async () => ({ kind: "approved", design: APPROVED })), state.taskId, { id: OPERATION, kind: "task", workflowMode: "SPEC_WRITE" }, outcome);
    written.push(JSON.stringify(ok));
    expect(written[0]).toContain("Approved design (digest");
    expect(written[0]).not.toContain("MODEL-DESIGN-TEXT");
    const waiting = JSON.stringify(await specOperationEndItems(env(async () => ({ kind: "wait" })), state.taskId, { id: OPERATION, kind: "task", workflowMode: "SPEC_WRITE" }, outcome));
    expect(waiting).not.toContain("Approved design");
    expect(waiting).toContain("write_failed");
    const failing = JSON.stringify(await specOperationEndItems(env(async () => { throw new Error("x"); }), state.taskId, { id: OPERATION, kind: "task", workflowMode: "SPEC_WRITE" }, outcome));
    expect(failing).toContain("write_failed");
    // No design hook (an install without design review): the spec is what the model wrote.
    expect(JSON.stringify(await specOperationEndItems(env(), state.taskId, { id: OPERATION, kind: "task", workflowMode: "SPEC_WRITE" }, outcome))).toContain("MODEL-DESIGN-TEXT");
  });

  it("the spec pull request description carries one line of counts and nothing from the findings", () => {
    const line = designReviewedLine(reviewOf(), 1);
    expect(line).toBe("Design reviewed: 3 reviewers, 1 open blocker");
    const body = specPullRequestBody({ taskTitle: "T", requirementCount: 2, taskPageUrl: "https://rovara.example/t/1", designLine: line });
    expect(body).toContain(line);
    expect(body).not.toContain(FINDING_TEXT);
    expect(specPullRequestBody({ taskTitle: "T", requirementCount: 2, taskPageUrl: "https://rovara.example/t/1" })).not.toContain("Design reviewed");
  });
});
