// Test services, slice 3 (s3-fakes-run): which fixture sets a task's plan may name. A fake in the approved environment is pinned to the DIGEST of a fixture set; the plan may carry it only while that set is approved for THIS
// organisation (the store answers for the organisation the caller passes, which is the task's, never one a request named). A set that is pending, rejected, withdrawn, held by another organisation or nobody, or a store that cannot
// be asked, leaves the digest out, and the plan refuses the run in fixed words (a run that left the fake out would only fail its tests in a confusing way).
//
// The store is a PORT: `FixtureReadPort` is the part of `FixtureStore` (test-env/fixture-store.ts) this lane reads. The adapters over S3 and DynamoDB (s3-fakes-store) make the real one; until it is wired
// `AwsBrokerDependencies.fixtureStore` is absent and every fake is refused.
import type { OrgId, TaskDependencyPlan, TestEnvDependency, TestEnvironmentBody } from "@agentx/contracts";
import type { FixtureStore } from "./fixture-store.js";

/** What this lane asks of the fixture store. */
export type FixtureReadPort = Pick<FixtureStore, "record" | "readApproved" | "deliver">;

/** An approved fixture set, as the plan and the evidence need it. */
export interface ApprovedFixture {
  digest: string;
  family: string;
  /** `recorded` when a recorder made it, `hand_written` when a person did (the less trusted word is the fallback elsewhere). */
  origin: "recorded" | "hand_written";
}

const fakeDigestOf = (backing: TestEnvDependency["backing"] | undefined): string | undefined => (backing?.kind === "fake" ? backing.fixtureSetRef : undefined);

/** The distinct fixture set digests an environment's dependencies name, in order, for the checks and for the working sandbox. */
export function fixtureDigestsOfEnvironment(body: Pick<TestEnvironmentBody, "dependencies">): string[] {
  const digests = (body.dependencies ?? []).flatMap((dependency) => [fakeDigestOf(dependency.backing), fakeDigestOf(dependency.workingBacking), fakeDigestOf(dependency.fallback)]);
  return [...new Set(digests.filter((digest): digest is string => digest !== undefined))];
}

/** The distinct fixture set digests a PLAN names (what a run is allowed to ask the broker to deliver). */
export function fixtureDigestsOfPlan(plan: { dependencies?: readonly TaskDependencyPlan[] | undefined } | undefined): string[] {
  return [...new Set((plan?.dependencies ?? []).flatMap((dependency) => (dependency.backing === "fake" && dependency.fake !== undefined ? [dependency.fake.fixtureSetRef] : [])))];
}

/**
 * The approved sets among those the environment names, by digest. Never throws. A set counts only if its row says `approved` and clean for this organisation, and the row's own org and digest are what was asked (the store
 * checks that too; this is the plan's second look).
 */
export async function approvedFixturesOf(store: Pick<FixtureReadPort, "record"> | undefined, orgId: OrgId, body: Pick<TestEnvironmentBody, "dependencies">): Promise<ReadonlyMap<string, ApprovedFixture>> {
  const found = new Map<string, ApprovedFixture>();
  if (store === undefined) return found;
  for (const digest of fixtureDigestsOfEnvironment(body)) {
    try {
      const answer = await store.record(orgId, digest);
      if (!answer.ok) continue;
      const row = answer.record;
      if (row.status !== "approved" || row.scanClean !== true || row.orgId !== orgId || row.digest !== digest) continue;
      found.set(digest, { digest, family: row.family, origin: row.origin === "recorded" ? "recorded" : "hand_written" });
    } catch {
      // A store that cannot be asked approves nothing.
    }
  }
  return found;
}
