// 0.5.14: the production switch of "new companies by invitation only". The stack parameter reaches the sign-in function as DEVELOPER_NEW_COMPANIES_INVITE_ONLY, and
// buildDependencies (what the Lambda builds from its environment) must turn it into the flag rule 3 reads and into the cloud pool's admin API the invite path uses. The
// other invitation-only tests build the server from a test harness, so without this one nothing would notice the environment variable no longer being read.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDependencies } from "../../packages/broker/src/aws/developer-identity.js";

const cloudEnvironment = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  AGENTX_ENV: "staging", AWS_REGION: "us-west-2", DEVELOPER_TOKEN_ISSUER: "https://abc123.execute-api.us-west-2.amazonaws.com/v1/auth",
  SLACK_SECRET_ARN: "arn:aws:secretsmanager:us-west-2:111122223333:secret:agentx/staging/slack-AbCdEf", STATE_TABLE_NAME: "state", DEVELOPER_SIGNIN_TABLE_NAME: "signin",
  DEVELOPER_TOKEN_KEY_ARN: "arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555",
  DEVELOPER_CLOUD_ISSUER: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_AbCdEfGhI", DEVELOPER_CLOUD_CLIENT_ID: "client-id", DEVELOPER_CLOUD_SECRET_ID: "agentx/staging/developer-cloud",
  DEVELOPER_CLOUD_USER_POOL_ID: "us-west-2_AbCdEfGhI", ...extra,
});

afterEach(() => { vi.restoreAllMocks(); });

describe("the environment turns invitation-only on (buildDependencies)", () => {
  it("DEVELOPER_NEW_COMPANIES_INVITE_ONLY=1 gives the server the flag rule 3 reads, and the cloud pool's admin API with its limits, for that one pool", () => {
    const deps = buildDependencies(cloudEnvironment({ DEVELOPER_NEW_COMPANIES_INVITE_ONLY: "1" }));
    expect(deps.newOrgsByInvitationOnly).toBe(true);
    expect(deps.invitedUsers?.userPoolId).toBe("us-west-2_AbCdEfGhI");
    expect(typeof deps.invitedUsers?.client.send).toBe("function");
    expect(typeof deps.invitedUsers?.limits.takeInviteUserSlot).toBe("function");
    expect(typeof deps.invitedUsers?.limits.releaseInviteUserSlot).toBe("function");
  });

  it.each([[undefined], ["0"], ["true"], ["1 "], [""]])("%j leaves new companies open, as an install without the setting has them", (value) => {
    const deps = buildDependencies(cloudEnvironment(value === undefined ? {} : { DEVELOPER_NEW_COMPANIES_INVITE_ONLY: value }));
    expect(deps.newOrgsByInvitationOnly).toBeUndefined();
  });

  it("a Rovara Code or self-hosted environment (no cloud sign-in, no variable) has neither the flag nor the pool", () => {
    const { DEVELOPER_CLOUD_ISSUER, DEVELOPER_CLOUD_CLIENT_ID, DEVELOPER_CLOUD_SECRET_ID, DEVELOPER_CLOUD_USER_POOL_ID, ...selfHosted } = cloudEnvironment();
    void DEVELOPER_CLOUD_ISSUER; void DEVELOPER_CLOUD_CLIENT_ID; void DEVELOPER_CLOUD_SECRET_ID; void DEVELOPER_CLOUD_USER_POOL_ID;
    const deps = buildDependencies(selfHosted);
    expect(deps.newOrgsByInvitationOnly).toBeUndefined();
    expect(deps.invitedUsers).toBeUndefined();
  });

  it("with the setting on but no cloud pool configured it still refuses to make companies, and says once that invitees cannot be given a sign-in", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { DEVELOPER_CLOUD_USER_POOL_ID, ...withoutPool } = cloudEnvironment({ DEVELOPER_NEW_COMPANIES_INVITE_ONLY: "1" });
    void DEVELOPER_CLOUD_USER_POOL_ID;
    const deps = buildDependencies(withoutPool);
    expect(deps.newOrgsByInvitationOnly).toBe(true);
    expect(deps.invitedUsers).toBeUndefined();
    const lines = log.mock.calls.map((call) => JSON.parse(String(call[0])) as { event?: string });
    expect(lines.filter((line) => line.event === "signin.invite_only_without_pool")).toHaveLength(1);
    // And the working configuration says nothing.
    log.mockClear();
    buildDependencies(cloudEnvironment({ DEVELOPER_NEW_COMPANIES_INVITE_ONLY: "1" }));
    expect(log.mock.calls.map((call) => String(call[0])).join("")).not.toContain("invite_only_without_pool");
  });
});
