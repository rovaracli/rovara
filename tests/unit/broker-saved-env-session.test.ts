// SH22: the broker's registry sessions for saved environment images. A session is minted only for an APPROVED, PROVED environment, names ONE repository in its policy, and fails with a fixed word.
import { describe, expect, it } from "vitest";
import { companyImageRepositoryName } from "@agentx/cloud-contracts";
import { SAVED_ENV_PULL_SESSION_SECONDS, SAVED_ENV_PUSH_SESSION_SECONDS, savedEnvRepositoryName } from "@rovara-code/contracts";
import { expectedRepositoryPolicy, mintManageSession, mintPullSession, mintPushSession, mintPullSessionFor, mintScanSession, verifyRepository, verifyRepositoryNamed, type RepositoryDescription, type SavedEnvSessionConfig, type SavedEnvSessionPorts } from "../../packages/broker/src/test-env/saved-env-session.js";

const SCOPE = { partition: "aws", region: "us-west-2", account: "111122223333" };
const KMS = "arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555";
const CONFIG: SavedEnvSessionConfig = { enabled: true, env: "test", scope: SCOPE, kmsKeyArn: KMS };
const GOOD_REPOSITORY = (): RepositoryDescription => ({ encryptionType: "KMS", kmsKey: KMS, imageTagMutability: "IMMUTABLE", policyText: JSON.stringify(expectedRepositoryPolicy(CONFIG)) });
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
    async inspectRepository() { return GOOD_REPOSITORY(); },
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
    // the first assume is the manage session of the squatting check; the second is the push
    expect(p.assumed).toHaveLength(2);
    expect(p.assumed[0]!.roleArn).toContain("img-manage");
    const push = p.assumed[1]!;
    expect(push.roleArn).toBe("arn:aws:iam::111122223333:role/agentx/test/agentx-test-img-push");
    expect(push.durationSeconds).toBe(SAVED_ENV_PUSH_SESSION_SECONDS);
    expect(push.durationSeconds).toBe(3_600);
    const policy = JSON.parse(push.policy) as { Statement: Array<{ Resource: string }> };
    expect(policy.Statement.map((s) => s.Resource)).toEqual(["*", `arn:aws:ecr:us-west-2:111122223333:repository/${repo()}`]);
    expect(result.auth.repository).toBe(repo());
    expect(result.auth.registry).toBe(REGISTRY);
    // The login ends with the session, not with the token's own 12 hours.
    expect(result.expiresAtMs).toBe(NOW + 900_000);
    expect(JSON.stringify(p.assumed)).not.toContain("org-1");
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

  it("a token for a registry on the machine itself is refused too (W0-3 review H1)", async () => {
    for (const registry of ["127.0.0.1:5000", "localhost:5001"]) {
      const p = ports({ authorizationToken: async () => ({ password: secretText(), registry, expiresAtMs: NOW + 1_000_000 }) });
      expect(await mintPushSession(CONFIG, p, { ...ids, approved: APPROVED }), registry).toEqual({ ok: false, reason: "unavailable" });
    }
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
  it("is minted for a task pinned to the project's newest approved revision, with the pull role, a read-only policy and a 30 minute session", async () => {
    const p = ports();
    const result = await mintPullSession(CONFIG, p, { ...ids, approved: APPROVED });
    expect(result.ok).toBe(true);
    const pull = p.assumed[1]!;
    expect(pull.roleArn).toContain("img-pull");
    expect(pull.durationSeconds).toBe(SAVED_ENV_PULL_SESSION_SECONDS);
    expect(pull.durationSeconds).toBeGreaterThanOrEqual(900);
    expect(pull.durationSeconds).toBeLessThanOrEqual(1_800);
    const actions = (JSON.parse(pull.policy) as { Statement: Array<{ Action: string | string[] }> }).Statement.flatMap((s) => [s.Action].flat());
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
    expect(p.assumed[0]!.policy).toContain("ecr:GetRepositoryPolicy");
  });
  it("is refused with the switch off", async () => {
    expect(await mintManageSession({ ...CONFIG, enabled: false }, ports(), ids)).toEqual({ ok: false, reason: "disabled" });
  });
});

describe("scan session", () => {
  it("is the push role limited to starting a scan and reading findings on one repository, for the broker's own use", async () => {
    const p = ports();
    const result = await mintScanSession(CONFIG, p, ids);
    expect(result).toMatchObject({ ok: true, repository: repo() });
    expect(p.assumed[0]!.roleArn).toContain("img-push");
    const actions = (JSON.parse(p.assumed[0]!.policy) as { Statement: Array<{ Action: string | string[] }> }).Statement.flatMap((s) => [s.Action].flat());
    expect(actions.sort()).toEqual(["ecr:DescribeImageScanFindings", "ecr:StartImageScan"]);
    expect(await mintScanSession({ ...CONFIG, enabled: false }, ports(), ids)).toEqual({ ok: false, reason: "disabled" });
  });
});

describe("squatting: the repository must be the one the creation template made", () => {
  const variants: Array<[string, (d: RepositoryDescription) => RepositoryDescription]> = [
    ["AES256 encryption", (d) => ({ ...d, encryptionType: "AES256", kmsKey: undefined })],
    ["another KMS key", (d) => ({ ...d, kmsKey: "arn:aws:kms:us-west-2:111122223333:key/99999999-2222-3333-4444-555555555555" })],
    ["mutable tags", (d) => ({ ...d, imageTagMutability: "MUTABLE" })],
    ["no policy", (d) => ({ ...d, policyText: undefined })],
    ["a policy that lets someone else read", (d) => ({ ...d, policyText: JSON.stringify({ Version: "2012-10-17", Statement: [{ Sid: "Open", Effect: "Allow", Principal: "*", Action: "ecr:BatchGetImage" }] }) })],
    ["the template's policy with one role changed", (d) => ({ ...d, policyText: d.policyText!.replace("img-pull", "img-pwned") })],
  ];

  it.each(variants)("a repository with %s is refused for push and for pull, and no login is minted", async (_name, change) => {
    const p = ports({ inspectRepository: async () => change(GOOD_REPOSITORY()) });
    expect(await mintPushSession(CONFIG, p, { ...ids, approved: APPROVED })).toEqual({ ok: false, reason: "unavailable" });
    expect(await mintPullSession(CONFIG, p, { ...ids, approved: APPROVED })).toEqual({ ok: false, reason: "unavailable" });
    expect(p.tokens).toBe(0);
    expect(p.assumed.every((request) => request.roleArn.includes("img-manage"))).toBe(true);
  });

  it("the template's own repository passes whatever the key order or spacing of the policy", async () => {
    const reordered = JSON.stringify(expectedRepositoryPolicy(CONFIG), null, 4).split("\n").join("\n  ");
    const p = ports({ inspectRepository: async () => ({ ...GOOD_REPOSITORY(), policyText: reordered }) });
    expect((await mintPushSession(CONFIG, p, { ...ids, approved: APPROVED })).ok).toBe(true);
    expect(await verifyRepository(CONFIG, p, ids)).toEqual({ ok: true, state: "matches" });
  });

  it("a project's repository made BEFORE the mirror role was added (the older template's policy, no mirror role) still passes, for push, pull and the check; the mirror role changes nothing there", async () => {
    const old = (): RepositoryDescription => ({ ...GOOD_REPOSITORY(), policyText: JSON.stringify(expectedRepositoryPolicy(CONFIG, { withMirror: false })) });
    expect(JSON.stringify(expectedRepositoryPolicy(CONFIG, { withMirror: false }))).not.toContain("img-mirror");
    expect(JSON.stringify(expectedRepositoryPolicy(CONFIG))).toContain("img-mirror");
    const p = ports({ inspectRepository: async () => old() });
    expect(await verifyRepository(CONFIG, p, ids)).toEqual({ ok: true, state: "matches" });
    expect((await mintPushSession(CONFIG, p, { ...ids, approved: APPROVED })).ok).toBe(true);
    expect((await mintPullSession(CONFIG, p, { ...ids, approved: APPROVED })).ok).toBe(true);
    // Either form must still be EXACT: the old policy with a role changed, or with the mirror role in only some lists, is refused.
    for (const policyText of [old().policyText!.replace("img-pull", "img-pwned"), JSON.stringify({ Version: "2012-10-17", Statement: [] }), old().policyText!.replace(/"arn[^"]*img-push"/u, `"arn:aws:iam::111122223333:role/agentx/test/agentx-test-img-mirror"`)]) {
      const refused = ports({ inspectRepository: async () => ({ ...old(), policyText }) });
      expect(await verifyRepository(CONFIG, refused, ids), policyText).toEqual({ ok: false, reason: "unavailable" });
    }
  });

  it("a company image's mirror repository must have the policy WITH the mirror role: the old form is a repository someone else made first", async () => {
    const mirrorName = companyImageRepositoryName({ env: "test", orgId: "org_aaaaaaaaaaaaaaaaaaaa", imageId: "img_" + "1".repeat(20) });
    const withMirror = ports({ inspectRepository: async () => GOOD_REPOSITORY() });
    expect(await verifyRepositoryNamed(CONFIG, withMirror, mirrorName)).toEqual({ ok: true, state: "matches" });
    const old = ports({ inspectRepository: async () => ({ ...GOOD_REPOSITORY(), policyText: JSON.stringify(expectedRepositoryPolicy(CONFIG, { withMirror: false })) }) });
    expect(await verifyRepositoryNamed(CONFIG, old, mirrorName)).toEqual({ ok: false, reason: "unavailable" });
    expect((await mintPullSessionFor(CONFIG, old, mirrorName)).ok).toBe(false);
    expect((await mintPullSessionFor(CONFIG, withMirror, mirrorName)).ok).toBe(true);
  });

  it("a repository that does not exist yet may be pushed to (the first push creates it) and is verified again after, but has nothing to pull", async () => {
    const p = ports({ inspectRepository: async () => "absent" });
    expect((await mintPushSession(CONFIG, p, { ...ids, approved: APPROVED })).ok).toBe(true);
    expect(await verifyRepository(CONFIG, p, ids)).toEqual({ ok: true, state: "absent" });
    expect(await mintPullSession(CONFIG, p, { ...ids, approved: APPROVED })).toEqual({ ok: false, reason: "unavailable" });
  });

  it("an error while describing the repository is `unavailable`, not a pass", async () => {
    const p = ports({ inspectRepository: async () => { throw new Error("AccessDenied arn:aws:ecr:..."); } });
    expect(await mintPushSession(CONFIG, p, { ...ids, approved: APPROVED })).toEqual({ ok: false, reason: "unavailable" });
  });
});
