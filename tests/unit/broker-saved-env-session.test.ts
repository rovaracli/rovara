// SH22: the broker's registry sessions for saved environment images. A session is minted only for an APPROVED, PROVED environment, names ONE repository in its policy, and fails with a fixed word.
import { describe, expect, it } from "vitest";
import { savedEnvRepositoryName } from "../../packages/contracts/src/index.js";
import { mintManageSession, mintPullSession, mintPushSession, type SavedEnvSessionConfig, type SavedEnvSessionPorts } from "../../packages/broker/src/test-env/saved-env-session.js";

const SCOPE = { partition: "aws", region: "us-west-2", account: "111122223333" };
const CONFIG: SavedEnvSessionConfig = { enabled: true, env: "test", scope: SCOPE };
const APPROVED = { revision: 4, digest: "a".repeat(64) };
const NOW = Date.parse("2026-11-02T12:00:00Z");
const REGISTRY = "111122223333.dkr.ecr.us-west-2.amazonaws.com";
/** A value of the right shape built at run time. */
const secretText = (): string => ["tok", "en", "-", "x".repeat(40)].join("");

function ports(over: Partial<SavedEnvSessionPorts> = {}): SavedEnvSessionPorts & { assumed: Array<{ roleArn: string; sessionName: string; policy: string; durationSeconds: number }>; tokens: number } {
  const assumed: Array<{ roleArn: string; sessionName: string; policy: string; durationSeconds: number }> = [];
  const state = { assumed, tokens: 0 };
  const base: SavedEnvSessionPorts = {
    async assume(request) { assumed.push(request); return { credentials: { accessKeyId: "id", secretAccessKey: "s", sessionToken: "t" }, expiresAtMs: NOW + 900_000 }; },
    async authorizationToken() { state.tokens += 1; return { password: secretText(), registry: REGISTRY, expiresAtMs: NOW + 43_200_000 }; },
    async readApproved() { return APPROVED; },
    async proveHolds() { return true; },
    now: () => NOW,
    ...over,
  };
  return Object.assign(base, state, { get tokens() { return state.tokens; } });
}
const ids = { orgId: "org-1", projectId: "proj-1" };
const repo = (orgId = ids.orgId, projectId = ids.projectId) => savedEnvRepositoryName({ env: "test", orgId, projectId });

describe("push session", () => {
  it("is minted for the approved, proved environment: the role is the push role and the policy names this project's repository only", async () => {
    const p = ports();
    const result = await mintPushSession(CONFIG, p, { ...ids, approved: APPROVED });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(p.assumed).toHaveLength(1);
    expect(p.assumed[0]!.roleArn).toBe("arn:aws:iam::111122223333:role/agentx/test/agentx-test-img-push");
    expect(p.assumed[0]!.durationSeconds).toBe(900);
    const policy = JSON.parse(p.assumed[0]!.policy) as { Statement: Array<{ Resource: string }> };
    expect(policy.Statement.map((s) => s.Resource)).toEqual(["*", `arn:aws:ecr:us-west-2:111122223333:repository/${repo()}`]);
    expect(result.auth.repository).toBe(repo());
    expect(result.auth.registry).toBe(REGISTRY);
    // The login ends with the session (15 minutes), not with the token's own 12 hours.
    expect(result.expiresAtMs).toBe(NOW + 900_000);
    expect(JSON.stringify(p.assumed[0])).not.toContain("org-1");
  });

  it("is refused with the switch off, and then nothing reaches AWS", async () => {
    const p = ports();
    expect(await mintPushSession({ ...CONFIG, enabled: false }, p, { ...ids, approved: APPROVED })).toEqual({ ok: false, reason: "disabled" });
    expect(p.assumed).toHaveLength(0);
  });

  it("is refused when the project has no approved environment, a different revision or a different digest", async () => {
    for (const read of [async () => undefined, async () => ({ revision: 5, digest: APPROVED.digest }), async () => ({ revision: 4, digest: "b".repeat(64) })]) {
      const p = ports({ readApproved: read });
      expect(await mintPushSession(CONFIG, p, { ...ids, approved: APPROVED })).toEqual({ ok: false, reason: "not_approved" });
      expect(p.assumed).toHaveLength(0);
    }
  });

  it("is refused when the Prove report for the approved digest did not pass", async () => {
    const p = ports({ proveHolds: async () => false });
    expect(await mintPushSession(CONFIG, p, { ...ids, approved: APPROVED })).toEqual({ ok: false, reason: "not_proved" });
    expect(p.assumed).toHaveLength(0);
  });

  it("an AWS error becomes a fixed word and keeps nothing of the error", async () => {
    const p = ports({ assume: async () => { throw new Error("arn:aws:iam::111122223333:role/x is not authorized"); } });
    expect(await mintPushSession(CONFIG, p, { ...ids, approved: APPROVED })).toEqual({ ok: false, reason: "unavailable" });
  });

  it("a token for another registry shape is refused (the login must be for an ECR host)", async () => {
    const p = ports({ authorizationToken: async () => ({ password: secretText(), registry: "evil.example.com", expiresAtMs: NOW + 1_000_000 }) });
    expect(await mintPushSession(CONFIG, p, { ...ids, approved: APPROVED })).toEqual({ ok: false, reason: "unavailable" });
  });

  it("two projects of one org, and one project id in two orgs, get different repositories", async () => {
    const seen = new Set<string>();
    for (const input of [{ orgId: "org-1", projectId: "p1" }, { orgId: "org-1", projectId: "p2" }, { orgId: "org-2", projectId: "p1" }]) {
      const r = await mintPushSession(CONFIG, ports(), { ...input, approved: APPROVED });
      expect(r.ok).toBe(true);
      if (r.ok) seen.add(r.auth.repository);
    }
    expect(seen.size).toBe(3);
  });
});

describe("pull session", () => {
  it("is minted for a task pinned to the project's newest approved revision, with the pull role and a read-only policy", async () => {
    const p = ports();
    const result = await mintPullSession(CONFIG, p, { ...ids, approved: APPROVED });
    expect(result.ok).toBe(true);
    expect(p.assumed[0]!.roleArn).toContain("img-pull");
    const actions = (JSON.parse(p.assumed[0]!.policy) as { Statement: Array<{ Action: string | string[] }> }).Statement.flatMap((s) => [s.Action].flat());
    expect(actions.sort()).toEqual(["ecr:BatchGetImage", "ecr:GetAuthorizationToken", "ecr:GetDownloadUrlForLayer"]);
  });

  it("is refused for a task pinned to another revision, and with the switch off", async () => {
    expect(await mintPullSession(CONFIG, ports({ readApproved: async () => ({ revision: 9, digest: APPROVED.digest }) }), { ...ids, approved: APPROVED })).toEqual({ ok: false, reason: "not_approved" });
    expect(await mintPullSession({ ...CONFIG, enabled: false }, ports(), { ...ids, approved: APPROVED })).toEqual({ ok: false, reason: "disabled" });
  });

  it("does not need the Prove report (a task uses an image that was built from one)", async () => {
    const p = ports({ proveHolds: async () => { throw new Error("not asked"); } });
    expect((await mintPullSession(CONFIG, p, { ...ids, approved: APPROVED })).ok).toBe(true);
  });
});

describe("manage session", () => {
  it("is for one repository, with no registry token, and hands back credentials for the broker's own use", async () => {
    const p = ports();
    const result = await mintManageSession(CONFIG, p, ids);
    expect(result).toMatchObject({ ok: true, repository: repo() });
    expect(p.assumed[0]!.roleArn).toContain("img-manage");
    expect(p.tokens).toBe(0);
    expect(p.assumed[0]!.policy).not.toContain("GetAuthorizationToken");
  });
  it("is refused with the switch off", async () => {
    expect(await mintManageSession({ ...CONFIG, enabled: false }, ports(), ids)).toEqual({ ok: false, reason: "disabled" });
  });
});
