// Wire lane D (MD-1): the spec seams (read a meta file, read the spec pull request, publish the spec) are on EVERY route dependency the broker builds, not only the sweep's. A review or a code
// pull request that needs the spec used to wait (fail closed) on any other path until the sweep ran it.
import { describe, expect, it } from "vitest";
import { specSeamsOf } from "../../packages/broker/src/aws/broker/spec-wiring.js";
import { workflowApplicationRouteDependencies } from "../../packages/broker/src/aws/broker/slack-workflow-events.js";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes/dependencies.js";
import type { AwsBrokerDependencies } from "../../packages/broker/src/aws/broker/definitions.js";

const broker = { documentClient: { send: async () => ({}) }, tableName: "t", githubPullRequests: {} } as unknown as AwsBrokerDependencies;

describe("the spec seams", () => {
  it("are three functions made from the broker's own dependencies", () => {
    const seams = specSeamsOf(broker);
    expect(Object.keys(seams).sort()).toEqual(["publishSpecFiles", "readMetaFile", "readSpecPullRequest"]);
    for (const seam of Object.values(seams)) expect(typeof seam).toBe("function");
  });

  it("ride on the application route dependencies the HTTP routes and the Slack presses share", () => {
    const shared = workflowApplicationRouteDependencies(broker) as Record<string, unknown>;
    for (const name of ["readMetaFile", "readSpecPullRequest", "publishSpecFiles"]) expect(typeof shared[name], name).toBe("function");
  });

  it("reach the task route dependencies a handler builds from them", () => {
    const route = developerTaskRouteDependencies({
      documentClient: broker.documentClient, tableName: "t", now: Date.now, developer: { issuer: "https://x.test", slackTeamId: undefined } as never, tasks: {} as never,
      ...workflowApplicationRouteDependencies(broker),
    }, { developerId: "d".repeat(64), sessionId: "s", amr: "github", name: "N", orgId: "org_aaaaaaaaaaaaaaaaaaaa", orgRole: "member" } as never);
    for (const name of ["readMetaFile", "readSpecPullRequest", "publishSpecFiles"] as const) expect(typeof route[name], name).toBe("function");
  });
});
