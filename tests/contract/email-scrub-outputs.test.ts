// S3 review fixes (H3, M1, M4): the pull request's status block rewrite, the Linear answer, the decision cards, the agent's Slack report and the near-cap pull request body carry no email
// address. Fake addresses are built at runtime.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EMAIL_HIDDEN } from "../../packages/contracts/src/index.js";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { fitPullRequestBody } from "../../packages/broker/src/aws/developer-tasks/pull-request-body.js";
import { workflowPullRequestBody, workflowPullRequestStatusLines } from "../../packages/broker/src/aws/developer-tasks.js";
import { PULL_REQUEST_STATUS_END, PULL_REQUEST_STATUS_START } from "../../packages/broker/src/developer/pull-request-feedback-section.js";
import { ROVARA_STATUS_END, ROVARA_STATUS_START, rovaraPullRequestBody } from "../../packages/broker/src/rovara-code/pull-request-body.js";
import { linearAnswerText } from "../../packages/broker/src/agent-sessions/ask.js";
import { cardOfItem, type DecisionItem } from "../../packages/broker/src/decisions/project.js";
import { slackCardMessage } from "../../packages/broker/src/decisions/slack-card.js";
import { prepareSlackReport } from "../../packages/broker/src/agents/slack-report.js";

const AT = String.fromCharCode(64);
const mail = (local: string, domain = "example.test") => `${local}${AT}${domain}`;
const OMAR = mail("omar.diaz");

const now = "2026-10-25T12:00:00.000Z";
const code = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
const review = (role: "CRITIC" | "SECURITY") => ({ operationId: randomUUID(), candidateDigest: code.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now });
const workflow = (definitionVersion: "1.0.0" | "1.1.0") => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now, definitionVersion }),
  stage: "PULL_REQUEST", state: "READY", candidate: code,
  checkPolicy: { required: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/payments", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [], proposed: [] },
  verification: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
  reviews: [review("CRITIC"), review("SECURITY")],
});
const context = { changedFiles: { files: [{ repository: "payments", path: "src/retry.ts", added: 3, removed: 1 }], complete: true } };

describe("H3: the pull request's status block, rewritten after a pushed fix", () => {
  it("version 2: the second-review and proof lines carry no address", () => {
    const lines = workflowPullRequestStatusLines(workflow("1.1.0"), { ...context, secondReviewLines: [`- second review by ${OMAR}`] }, [`- proof for ${OMAR}`]);
    expect(lines.join("\n")).not.toContain(OMAR);
    expect(lines.join("\n")).toContain(EMAIL_HIDDEN);
  });

  it("version 1: the second-review and proof lines carry no address", () => {
    const lines = workflowPullRequestStatusLines(workflow("1.0.0"), { secondReviewLines: [`- second review by ${OMAR}`] }, [`- proof for ${OMAR}`]);
    expect(lines.join("\n")).not.toContain(OMAR);
    expect(lines.join("\n")).toContain(EMAIL_HIDDEN);
  });

  it("lines with no address are what they were", () => {
    const lines = workflowPullRequestStatusLines(workflow("1.0.0"), { secondReviewLines: ["- second review passed"] }, ["- proof: 3 of 3"]);
    expect(lines).toContain("- second review passed");
    expect(lines).toContain("- proof: 3 of 3");
  });
});

describe("M4: hiding addresses never costs the pull request its closing marker", () => {
  it("a version 2 block that is close to the cap, full of short addresses, still ends with its marker, the session link and the closing line", () => {
    const short = mail("a", "b.co");
    const reviewLines = (listed: number) => Array.from({ length: Math.min(listed, 600) }, (_, i) => `- finding ${String(i)} for ${short} and ${short} and ${short} and ${short}`);
    const body = rovaraPullRequestBody({ summary: ["Retry failed payments"], fallbackTitle: "Retry", workflow: workflow("1.1.0"), context, reviewLines, pageUrl: "https://rovara.example/review/x/task" });
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(30_000);
    expect(body).not.toContain(short);
    expect(body).toContain(ROVARA_STATUS_START);
    expect(body).toContain(ROVARA_STATUS_END);
    expect(body).toContain("Rovara session: https://rovara.example/review/x/task");
  });

  it("workflowPullRequestBody: a version 1 body that fits only until its addresses are hidden loses summary, never its end marker, session link or closing line", () => {
    // Proof lines are free text, so they can fill the body. Calibrate on same-length placeholders until the raw body is just under the cap; hiding the 20 addresses then lengthens it past the cap.
    const plan = `# Plan\n\n${Array.from({ length: 3 }, (_, i) => `${String(i + 1)}. ${"Make the retry flag work for every payment path. ".repeat(3)}`).join("\n")}\n`;
    const page = "https://rovara.example/review/x/task";
    const lines = (pad: number, address: string) => [`- ${"p".repeat(pad)}`, ...Array.from({ length: 20 }, () => `- proof for ${address} ok`)];
    const bodyWith = (pad: number, address: string) => workflowPullRequestBody({ title: "Retry" } as never, workflow("1.0.0"), plan, page, undefined, lines(pad, address));
    const placeholder = "aXb.co";
    const pad = 29_950 - Buffer.byteLength(bodyWith(0, placeholder), "utf8");
    const raw = bodyWith(pad, placeholder);
    expect(Buffer.byteLength(raw, "utf8")).toBe(29_950);
    const body = bodyWith(pad, mail("a", "b.co"));
    // The addresses made the body longer than the cap would allow, and the summary paid for it.
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(30_000);
    expect(body).toContain(`...\n\n${PULL_REQUEST_STATUS_START}`);
    expect(body).toContain(PULL_REQUEST_STATUS_END);
    expect(body).toContain(`AgentX task: ${page}`);
    expect(body).toContain("Merge it on GitHub.");
    expect(body).not.toContain(mail("a", "b.co"));
  });
});

describe("M4: a body over the cap loses summary, not its marked block", () => {
  it("cuts the end of the summary in front of the block, keeping the block, the link and the closing line", () => {
    const summary = Array.from({ length: 200 }, (_, i) => `> summary line ${String(i)} ${"x".repeat(60)}`).join("\n");
    const block = Array.from({ length: 300 }, (_, i) => `- block line ${String(i)} ${"y".repeat(60)}`).join("\n");
    const tail = "Rovara session: https://rovara.example/review/x/task\n\nClosing line.";
    const body = `## Plan summary\n${summary}\n\n${ROVARA_STATUS_START}\n${block}\n${ROVARA_STATUS_END}\n${tail}`;
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(30_000 - 1);
    const fitted = fitPullRequestBody(body + "\n" + "z".repeat(1500));
    expect(Buffer.byteLength(fitted, "utf8")).toBeLessThanOrEqual(30_000);
    expect(fitted).toContain(ROVARA_STATUS_END);
    expect(fitted.endsWith("z".repeat(1500))).toBe(true);
    expect(fitPullRequestBody("short body")).toBe("short body");
  });
});

describe("M1: the Linear answer", () => {
  it("hides an address in the model's answer, before mentions are broken, and keeps the label", () => {
    const text = linearAnswerText(`Ask ${OMAR} or ${AT}maya about it.`);
    expect(text).not.toContain(OMAR);
    expect(text).toContain(`Ask ${EMAIL_HIDDEN} or ${AT}${String.fromCharCode(0x200b)}maya about it.`);
    expect(text).toContain("AI answer");
  });
});

describe("M1: decision cards", () => {
  const item: DecisionItem = {
    subjectId: "q1", taskId: "11111111-1111-4111-8111-111111111111", project: "payments", title: `Reply to ${OMAR}`, createdAt: "2026-10-30T10:00:00.000Z", contentVersion: "v1",
    openPath: `/app/sessions/ses_${"a".repeat(20)}`, kind: "answer_question", question: `Should we cc ${OMAR}?`, index: 1, of: 2,
  };

  it("the card's title and question carry no address, nor does its Slack message", () => {
    const card = cardOfItem(item, {})!.card;
    expect(JSON.stringify(card)).not.toContain(OMAR);
    expect(card.title).toBe(`Reply to ${EMAIL_HIDDEN}`);
    const message = slackCardMessage({ ...card, title: `Reply to ${OMAR}`, question: `cc ${OMAR}?` }, { cardUrl: "https://rovara.example/app/x", digest: "d" });
    expect(JSON.stringify(message)).not.toContain(OMAR);
  });
});

describe("M1: the agent's report in Slack", () => {
  it("hides an address in the report", () => {
    const prepared = prepareSlackReport(`Done. I wrote to ${OMAR} about the invoice.`, { orgId: "org_aaaaaaaaaaaaaaaaaaaa", taskUrl: "https://rovara.example/t/1", reportLinkDomains: [], extraCommandWords: [] });
    expect(prepared.kind).toBe("text");
    expect(prepared.text).not.toContain(OMAR);
    expect(prepared.text).toContain(EMAIL_HIDDEN);
  });
});
