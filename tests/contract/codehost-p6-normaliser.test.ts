// Enterprise foundations P6: the GitHub webhook normaliser. Every GitHub event the broker follows becomes a neutral code host event; a delivery is verified (size, signature,
// delivery id) before any of its body is read, and nothing comes back from one that does not verify.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeHostEventSchema } from "../../packages/contracts/src/index.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { GITHUB_WEBHOOK_MAX_BYTES, githubCodeHostEvents, neutralEventsOfGithub } from "../../packages/broker/src/plugins/code-host/github/events.js";
import { verifyGithubWebhookSignature } from "../../packages/broker/src/aws/github-webhooks.js";
import { WEBHOOK_SECRET, githubDelivery, githubPayloads, signGithubBody, webhookSecretReader } from "../plugins/github-deliveries.js";

const SCOPE = { system: "webhook" } as const;
const DELIVERY = "7f0b6a52-3c1e-4d6a-9d0e-2a1b3c4d5e6f";
const REF = { repository: { url: "https://github.com/acme/app" }, id: "7", url: "https://github.com/acme/app/pull/7" };
const events = githubCodeHostEvents(webhookSecretReader());
const normalise = (name: string, body: unknown, options: Parameters<typeof githubDelivery>[2] = {}) => events.normalise!(githubDelivery(name, body, { deliveryId: DELIVERY, ...options }), SCOPE);

afterEach(() => vi.restoreAllMocks());

describe("P6: a GitHub delivery becomes neutral events", () => {
  const table: Array<[string, string, unknown, Record<string, unknown>]> = [
    ["a pull request opened", "pull_request", githubPayloads.pullRequest("opened"), { type: "change_request.opened", ref: REF, actor: "priya" }],
    ["a pull request closed without a merge", "pull_request", githubPayloads.pullRequest("closed", 7, { merged: false }), { type: "change_request.closed", ref: REF }],
    ["a pull request merged", "pull_request", githubPayloads.pullRequest("closed", 7, { merged: true }), { type: "change_request.merged", ref: REF }],
    ["a pull request pushed to", "pull_request", githubPayloads.pullRequest("synchronize"), { type: "change_request.updated", ref: REF }],
    ["a pull request reopened", "pull_request", githubPayloads.pullRequest("reopened"), { type: "change_request.updated", ref: REF }],
    ["a pull request made ready", "pull_request", githubPayloads.pullRequest("ready_for_review"), { type: "change_request.updated", ref: REF }],
    ["a pull request edited", "pull_request", githubPayloads.pullRequest("edited"), { type: "change_request.updated", ref: REF }],
    ["a review that approves", "pull_request_review", githubPayloads.review("submitted", "approved"), { type: "review.submitted", ref: REF, state: "APPROVED" }],
    ["a review that asks for changes", "pull_request_review", githubPayloads.review("submitted", "changes_requested"), { type: "review.submitted", ref: REF, state: "CHANGES_REQUESTED" }],
    ["a review with comments only", "pull_request_review", githubPayloads.review("submitted", "commented"), { type: "review.submitted", ref: REF, state: "COMMENTED" }],
    ["a review dismissed", "pull_request_review", githubPayloads.review("dismissed", "approved"), { type: "review.submitted", ref: REF, state: "DISMISSED" }],
    ["an inline comment", "pull_request_review_comment", githubPayloads.reviewComment("created"), { type: "comment.created", ref: REF, commentId: "review_comment:555" }],
    ["an inline comment edited", "pull_request_review_comment", githubPayloads.reviewComment("edited"), { type: "change_request.updated", ref: REF }],
    ["a discussion comment on a pull request", "issue_comment", githubPayloads.issueComment("created"), { type: "comment.created", ref: REF, commentId: "discussion:556" }],
    ["a discussion comment deleted", "issue_comment", githubPayloads.issueComment("deleted"), { type: "change_request.updated", ref: REF }],
    ["a check run that finished", "check_run", githubPayloads.checkRun("completed", "failure"), { type: "check.completed", repository: { url: "https://github.com/acme/app" }, revision: "b".repeat(40), name: "unit", conclusion: "failure" }],
    ["a check suite that finished", "check_suite", githubPayloads.checkSuite("completed", "success"), { type: "check.completed", revision: "c".repeat(40), name: "ci-app", conclusion: "success" }],
    ["a commit status that passed", "status", githubPayloads.status("success"), { type: "check.completed", revision: "d".repeat(40), name: "ci/legacy", conclusion: "success" }],
    ["a commit status in error", "status", githubPayloads.status("error"), { type: "check.completed", conclusion: "error" }],
    ["a push to a branch", "push", githubPayloads.push("refs/heads/feature/x"), { type: "revision.pushed", repository: { url: "https://github.com/acme/app" }, branch: "feature/x", revision: "e".repeat(40) }],
  ];
  it.each(table)("%s", async (_label, name, body, expected) => {
    const result = await normalise(name, body);
    expect(result).toHaveLength(1);
    expect(CodeHostEventSchema.parse(result[0])).toMatchObject({ host: "github", eventId: DELIVERY, ...expected });
  });

  const nothing: Array<[string, string, unknown]> = [
    ["a pull request labelled", "pull_request", githubPayloads.pullRequest("labeled")],
    ["a check run still running", "check_run", githubPayloads.checkRun("created", null)],
    ["a check run completed with no conclusion", "check_run", githubPayloads.checkRun("completed", null)],
    ["a check run with a conclusion the port does not know", "check_run", githubPayloads.checkRun("completed", "made_up")],
    ["a check suite requested", "check_suite", githubPayloads.checkSuite("requested", null)],
    ["a commit status pending", "status", githubPayloads.status("pending")],
    ["a comment on an issue", "issue_comment", githubPayloads.issueComment("created", 7, false)],
    ["a tag pushed", "push", githubPayloads.push("refs/tags/v1")],
    ["a branch deleted", "push", githubPayloads.push("refs/heads/old", "0".repeat(40), true)],
    ["an event Rovara does not follow", "fork", { repository: { full_name: "acme/app" } }],
  ];
  it.each(nothing)("%s: signed and well formed, so no event and no error", async (_label, name, body) => {
    expect(await normalise(name, body)).toEqual([]);
  });

  it("builds the repository address from GitHub's repository name, never from a url in the body", async () => {
    const body = githubPayloads.pullRequest("opened", 7, { html_url: "https://evil.example.test/acme/app/pull/7" });
    const [event] = await normalise("pull_request", { ...body, repository: { ...body.repository, html_url: "https://evil.example.test/acme/app" } });
    expect(event).toMatchObject({ ref: REF });
  });

  it("refuses a repository name that is not a name", async () => {
    await expect(normalise("pull_request", { ...githubPayloads.pullRequest("opened"), repository: { id: 1, full_name: "acme/app/../../x" } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("refuses a followed event whose body cannot be read, with a fixed sentence", async () => {
    const refused = await normalise("pull_request", { action: "opened", repository: { full_name: "acme/app" } }).catch((error: unknown) => error as { code: string; message: string });
    expect(refused).toMatchObject({ code: "CONFIG_INVALID" });
    expect(refused.message).toContain("the delivery cannot be read");
  });

  it("refuses a review in a state it does not know", async () => {
    await expect(normalise("pull_request_review", githubPayloads.review("submitted", "approved_maybe"))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("P6: the delivery is verified before any of it is read", () => {
  it("refuses a bad signature without reading the body: an unparseable body gets the signature's refusal, and JSON is never parsed", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const delivery = githubDelivery("pull_request", undefined, { raw: "{ this is not json", signature: signGithubBody("something else"), deliveryId: DELIVERY });
    const refused = await events.normalise!(delivery, SCOPE).catch((error: unknown) => error as { code: string; message: string });
    expect(refused).toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    expect(refused.message).toContain("the delivery's signature does not verify");
    expect(parse).not.toHaveBeenCalledWith(delivery.rawBody);
  });

  it("refuses a missing signature header, a signature of the wrong shape and one made with another secret", async () => {
    const good = githubDelivery("pull_request", githubPayloads.pullRequest("opened"), { deliveryId: DELIVERY });
    const withoutSignature = Object.fromEntries(Object.entries(good.headers).filter(([name]) => name !== "x-hub-signature-256"));
    for (const headers of [withoutSignature, { ...good.headers, "x-hub-signature-256": "sha256=zz" }, { ...good.headers, "x-hub-signature-256": signGithubBody(good.rawBody, "another secret entirely") }]) {
      await expect(events.normalise!({ rawBody: good.rawBody, headers }, SCOPE)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
    }
  });

  it("refuses a body changed after it was signed", async () => {
    const good = githubDelivery("pull_request", githubPayloads.pullRequest("opened"), { deliveryId: DELIVERY });
    await expect(events.normalise!({ ...good, rawBody: good.rawBody.replace('"opened"', '"closed"') }, SCOPE)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
  });

  it("checks the size before the signature, and neither reads the body", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const big = "x".repeat(GITHUB_WEBHOOK_MAX_BYTES + 1);
    const refused = await events.normalise!({ rawBody: big, headers: { "x-hub-signature-256": signGithubBody(big), "x-github-delivery": DELIVERY, "x-github-event": "push" } }, SCOPE).catch((error: unknown) => error as { code: string });
    expect(refused).toMatchObject({ code: "CONFIG_INVALID" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("refuses a delivery id that is not one, after the signature has been verified and before the body is read", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const delivery = githubDelivery("pull_request", githubPayloads.pullRequest("opened"), { deliveryId: "not-a-uuid" });
    await expect(events.normalise!(delivery, SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(parse).not.toHaveBeenCalledWith(delivery.rawBody);
  });

  it("refuses a body that is signed but is not JSON", async () => {
    const raw = "not json at all";
    await expect(events.normalise!(githubDelivery("push", undefined, { raw, deliveryId: DELIVERY }), SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("takes header names in any case", async () => {
    const good = githubDelivery("pull_request", githubPayloads.pullRequest("opened"), { deliveryId: DELIVERY });
    const upper = Object.fromEntries(Object.entries(good.headers).map(([key, value]) => [key.toUpperCase(), value]));
    expect(await events.normalise!({ rawBody: good.rawBody, headers: upper }, SCOPE)).toHaveLength(1);
  });

  it("refuses a call with no valid scope", async () => {
    await expect(events.normalise!(githubDelivery("push", githubPayloads.push("refs/heads/x")), {} as never)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("rereads the secret once after a rotation: the old secret fails, the refreshed one verifies; a delivery that fails both is refused", async () => {
    const calls: Array<boolean | undefined> = [];
    const rotated = githubCodeHostEvents(async (options) => { calls.push(options?.refresh); return options?.refresh === true ? WEBHOOK_SECRET : "stale-secret-from-before-the-rotation"; });
    expect(await rotated.normalise!(githubDelivery("push", githubPayloads.push("refs/heads/x"), { deliveryId: DELIVERY }), SCOPE)).toHaveLength(1);
    expect(calls).toEqual([undefined, true]);
    const neverRight = githubCodeHostEvents(async () => "a secret that signs nothing here");
    await expect(neverRight.normalise!(githubDelivery("push", githubPayloads.push("refs/heads/x"), { deliveryId: DELIVERY }), SCOPE)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
  });

  it("refuses the delivery when the secret cannot be read, and never maps it", async () => {
    const broken = githubCodeHostEvents(async () => { throw new Error("secret store down"); });
    await expect(broken.normalise!(githubDelivery("push", githubPayloads.push("refs/heads/x")), SCOPE)).rejects.toThrow();
  });
});

describe("P6: the GitHub adapter offers a normaliser only when it has the webhook secret", () => {
  const provider = {} as Parameters<typeof githubCodeHost>[0];
  it("has none without a secret, so no delivery can be accepted through the port", () => {
    const host = githubCodeHost(provider, { credentialRef: "github" });
    expect(host.events.mode).toBe("webhook");
    expect("normalise" in host.events).toBe(false);
  });
  it("has one with the secret", () => {
    expect("normalise" in githubCodeHost(provider, { credentialRef: "github", webhookSecret: webhookSecretReader() }).events).toBe(true);
  });
});

describe("P6: the old webhook route and the normaliser share one signature check", () => {
  it("verifies exactly what GitHub signs", () => {
    const body = '{"a":1}';
    expect(verifyGithubWebhookSignature(body, signGithubBody(body), WEBHOOK_SECRET)).toBe(true);
    expect(verifyGithubWebhookSignature(body, signGithubBody(body, "other"), WEBHOOK_SECRET)).toBe(false);
    expect(verifyGithubWebhookSignature(body, undefined, WEBHOOK_SECRET)).toBe(false);
  });
  it("neutralEventsOfGithub is pure over an already verified body", () => {
    expect(neutralEventsOfGithub("push", githubPayloads.push("refs/heads/x"), DELIVERY)).toHaveLength(1);
  });
});
