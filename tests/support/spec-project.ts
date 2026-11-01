// A project with a meta repository in a fake table, for the tests that read a spec pull request or a file of the meta repository through `spec-wiring.ts`: the code host of that repository
// is now found from the project the task pinned (task P5d), so a task and its project must be there.
import { projectRevisionKey } from "../../packages/contracts/src/index.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";
import { TEST_ORG } from "./orgs.js";

/** The task fields the host lookup reads. */
export const specTask = { orgId: TEST_ORG, project: "demo", startingRevision: 1 } as const;

/** The project `demo` (revision 1) as a stored row, whose meta repository is `metaUrl`. */
export function specProjectItem(metaUrl: string, host?: { kind: string; ref?: string; installationId?: number; repositoryId?: number }) {
  return {
    ...projectRevisionKey(TEST_ORG, "demo", 1), entityType: "PROJECT", registeredAt: "2026-10-31T00:00:00.000Z",
    definition: { name: "demo", revision: 1, repositories: [{ name: "meta", url: metaUrl, path: "repo/meta", defaultBranch: "main", credentialRef: "github-app", role: "meta", ...(host === undefined ? {} : { host }) }], setup: [], readiness: [], orchestratorInstructions: "x" },
  };
}

/** `dependencies` with a table that holds the project `demo` (revision 1), whose meta repository is `metaUrl`; `host` is that repository's record `host`, when it names one. */
export function withSpecProject<T extends object>(dependencies: T, metaUrl: string, host?: { kind: string; ref?: string; installationId?: number; repositoryId?: number }): T & { documentClient: FakeDynamoDb; tableName: string } {
  const db = new FakeDynamoDb();
  db.set(specProjectItem(metaUrl, host));
  return { ...dependencies, documentClient: db, tableName: "state" };
}

/** A pull request status as GitHub's provider returns it, complete (the code host adapter maps every field), from the few fields a test cares about. */
export function fullStatus<R extends { state: string; commitId: string; login: string; githubUserId: string; userType: string }>(partial: { state?: "open" | "closed" | "merged"; headSha: string; reviews: R[] }) {
  return {
    number: 12, state: partial.state ?? "open", draft: false, headSha: partial.headSha, baseBranch: "main", mergeableState: "clean", checks: [], requiredChecks: [], baseHasRequiredChecks: false, headHasWorkflowFiles: false,
    requestedReviewers: 0, reviews: partial.reviews.map((review) => ({ submittedAt: "2026-10-31T10:00:00.000Z", ...review })),
  };
}
