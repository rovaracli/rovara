// Rovara Code (bug I): the broker's webhook processing wakes the tracking row for a review (and a ready, pushed or reopened pull request) and still hands the same event to the
// feedback path. The wake itself is tested in rovara-code-review-wake.test.ts; this file tests only that processGithubWorkflowEvent calls it, before the feedback path, without
// letting its failure stop that path, and not for the merge pass's own observation.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as TrackingEvents from "../../packages/broker/src/rovara-code/tracking-events.js";
import type { PullRequestWebhookEvent } from "../../packages/broker/src/aws/github-webhooks.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { TEST_ENV } from "../support/orgs.js";

const wake = vi.hoisted(() => ({ calls: [] as string[], fail: false }));

vi.mock("../../packages/broker/src/rovara-code/tracking-events.js", async (importOriginal) => {
  const original = await importOriginal<typeof TrackingEvents>();
  return {
    ...original,
    wakeFromPullRequestEvent: async (_deps: unknown, event: PullRequestWebhookEvent) => {
      wake.calls.push(`wake:${event.kind}:${event.action}`);
      if (wake.fail) throw new Error("dynamo is down");
      return "woken";
    },
  };
});

const review = (action: string, source: "review" | "review_comment" | "pr_discussion" = "review"): PullRequestWebhookEvent => ({
  kind: "PR_COMMENT", action, installationId: 7, repositoryId: 9, fullName: "acme/api", number: 1,
  comment: { id: 5, body: "Looks good", truncated: false, url: "https://github.com/acme/api/pull/1#pullrequestreview-5", author: "maint", source },
});

async function process(event: PullRequestWebhookEvent, options?: { observationMode: "merge" }) {
  await loadSlackBroker();
  const broker = await import("../../packages/broker/src/aws/broker.js");
  const gets: string[] = [];
  const dependencies = {
    tableName: "state", artifactBucketName: "artifacts", environmentName: TEST_ENV,
    documentClient: { send: async (command: { input?: { Key?: { pk?: string } } }) => { if (command.input?.Key?.pk !== undefined) { gets.push(command.input.Key.pk); wake.calls.push(`read:${command.input.Key.pk}`); } return {}; } },
    githubPullRequests: { getPullRequestFeedback: async () => { throw new Error("not reached without a linked task"); } },
  };
  // The feedback path refuses a pull request no task is linked to; that it got as far as asking is the point here.
  await broker.processGithubWorkflowEvent(dependencies as never, event, "delivery-1", options === undefined ? undefined : { ...options, budget: undefined as never, release: "queue" }).catch(() => undefined);
  return { gets, calls: wake.calls };
}

describe("processGithubWorkflowEvent and the tracking wake", () => {
  beforeEach(() => { wake.calls.length = 0; wake.fail = false; });

  it("wakes tracking for a submitted review, before the feedback path reads the pull request's link, which still runs", async () => {
    const { calls } = await process(review("submitted"));
    expect(calls[0]).toBe("wake:PR_COMMENT:submitted");
    expect(calls.slice(1).some((call) => call.startsWith("read:") && call.includes("GITHUB_PR#acme/api"))).toBe(true);
  });

  it("wakes tracking for a pull request made ready, pushed to or reopened, and for an edited or dismissed review", async () => {
    for (const event of [
      { kind: "PULL_REQUEST", action: "ready_for_review" }, { kind: "PULL_REQUEST", action: "synchronize" }, { kind: "PULL_REQUEST", action: "reopened" },
    ] as const) {
      wake.calls.length = 0;
      const { calls } = await process({ kind: event.kind, action: event.action, installationId: 7, repositoryId: 9, fullName: "acme/api", number: 1 });
      expect(calls[0], event.action).toBe(`wake:PULL_REQUEST:${event.action}`);
    }
    for (const action of ["edited", "dismissed"]) {
      wake.calls.length = 0;
      expect((await process(review(action))).calls[0], action).toBe(`wake:PR_COMMENT:${action}`);
    }
  });

  it("does not wake for a plain comment, and does not wake from the merge pass's own observation", async () => {
    expect((await process(review("created", "pr_discussion"))).calls.some((call) => call.startsWith("wake:"))).toBe(false);
    wake.calls.length = 0;
    const observed = await process({ kind: "PULL_REQUEST", action: "synchronize", installationId: 7, repositoryId: 9, fullName: "acme/api", number: 1 }, { observationMode: "merge" });
    expect(observed.calls.some((call) => call.startsWith("wake:"))).toBe(false);
  });

  it("goes on to the feedback path when the wake fails, and does not fail the delivery for it", async () => {
    wake.fail = true;
    const { calls } = await process(review("submitted"));
    expect(calls[0]).toBe("wake:PR_COMMENT:submitted");
    expect(calls.slice(1).some((call) => call.startsWith("read:") && call.includes("GITHUB_PR#acme/api"))).toBe(true);
  });
});
