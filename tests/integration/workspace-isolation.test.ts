import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { OrgId, ProjectDefinition } from "@rovara-code/contracts";
import {
  InMemoryProjectRegistry,
  InMemoryRegistry,
  WorkspaceResolver,
  type AuthenticatedIdentity,
  type ProjectMembership,
} from "../../packages/broker/src/index.js";
import { describe, expect, it } from "vitest";
import { TEST_ORG } from "../support/orgs.js";

const OTHER_ORG = "org_zzzzzzzzzzzzzzzzzzzz" as OrgId;

const run = promisify(execFile);

describe("per-developer workspace isolation", () => {
  it("resolves only the authenticated owner's instance and denies altered identifiers", async () => {
    const admin = identity("a");
    const alice = identity("b", false);
    const bob = identity("c", false);
    const memberships: ProjectMembership[] = [
      { ownerKey: admin.ownerKey, project: "payments", role: "administrator" },
      { ownerKey: alice.ownerKey, project: "payments", role: "developer" },
      { ownerKey: bob.ownerKey, project: "payments", role: "developer" },
    ];
    const projects = new InMemoryProjectRegistry();
    projects.register(admin, projectDefinition(), memberships);
    const registry = new InMemoryRegistry();
    const aliceWorkspace = await registry.createDefault(workspace(alice.ownerKey, TEST_ORG));
    const bobWorkspace = await registry.createDefault(workspace(bob.ownerKey, TEST_ORG));
    const resolver = new WorkspaceResolver({ projects, registry, memberships });

    await expect(resolver.resolveDefault(alice, "payments", 1)).resolves.toMatchObject({
      id: aliceWorkspace.id,
      projectName: "payments",
      status: "READY",
    });
    await expect(resolver.resolveDefault(bob, "payments", 1)).resolves.toMatchObject({
      id: bobWorkspace.id,
    });
    await expect(resolver.getById(alice, bobWorkspace.id)).rejects.toThrow(/not found/i);
    const selected = await resolver.resolveDefault(alice, "payments", 1);
    expect(selected).not.toHaveProperty("runtimeSessionId");
    expect(selected).not.toHaveProperty("runtimeArn");

    const concurrent = await Promise.all(
      Array.from({ length: 20 }, async () => resolver.resolveDefault(alice, "payments", 1)),
    );
    expect(new Set(concurrent.map(({ id }) => id))).toEqual(new Set([aliceWorkspace.id]));

    const privateResources = new Map([
      [aliceWorkspace.id, { conversation: "alice history", artifact: "alice diff" }],
      [bobWorkspace.id, { conversation: "bob history", artifact: "bob diff" }],
    ]);
    const readPrivateResources = async (caller: AuthenticatedIdentity, workspaceId: string) => {
      await resolver.getById(caller, workspaceId);
      return privateResources.get(workspaceId);
    };
    await expect(readPrivateResources(alice, aliceWorkspace.id)).resolves.toEqual({
      conversation: "alice history",
      artifact: "alice diff",
    });
    await expect(readPrivateResources(alice, bobWorkspace.id)).rejects.toThrow(/not found/i);
  });

  it("reads a workspace of another org, or a caller with no org, as not found even for the same owner", async () => {
    const alice = identity("b", false);
    const memberships: ProjectMembership[] = [{ ownerKey: alice.ownerKey, project: "payments", role: "developer" }];
    const registry = new InMemoryRegistry();
    const ownWorkspace = await registry.createDefault(workspace(alice.ownerKey, TEST_ORG));
    const foreignOrg = await registry.createDefault({ ...workspace(alice.ownerKey, OTHER_ORG), projectName: "billing" });
    const resolver = new WorkspaceResolver({ projects: new InMemoryProjectRegistry(), registry, memberships });

    await expect(resolver.getById(alice, ownWorkspace.id)).resolves.toMatchObject({ id: ownWorkspace.id });
    await expect(resolver.getById(alice, foreignOrg.id)).rejects.toThrow(/workspace not found/i);
    await expect(resolver.getById({ ...alice, orgId: OTHER_ORG }, ownWorkspace.id)).rejects.toThrow(/workspace not found/i);
    const noOrg = { ...alice };
    delete noOrg.orgId;
    await expect(resolver.getById(noOrg, ownWorkspace.id)).rejects.toThrow(/workspace not found/i);
  });

  it("keeps private edits invisible until the owner explicitly publishes and the peer integrates", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "agentx-isolation-"));
    const shared = join(fixtureRoot, "shared.git");
    const seed = join(fixtureRoot, "seed");
    const alice = join(fixtureRoot, "alice");
    const bob = join(fixtureRoot, "bob");
    await run("git", ["init", "--bare", "--quiet", shared]);
    await run("git", ["clone", "--quiet", shared, seed]);
    await writeFile(join(seed, "app.txt"), "initial\n");
    await run("git", ["-C", seed, "add", "app.txt"]);
    await run("git", ["-C", seed, "-c", "user.name=AgentX", "-c", "user.email=agentx@example.test", "commit", "--quiet", "-m", "initial"]);
    await run("git", ["-C", seed, "push", "--quiet", "origin", "HEAD:main"]);
    await run("git", ["--git-dir", shared, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await Promise.all([
      run("git", ["clone", "--quiet", shared, alice]),
      run("git", ["clone", "--quiet", shared, bob]),
    ]);

    await writeFile(join(alice, "app.txt"), "alice private edit\n");
    await writeFile(join(alice, "untracked.txt"), "private\n");
    await expect(readFile(join(bob, "app.txt"), "utf8")).resolves.toBe("initial\n");
    await expect(access(join(bob, "untracked.txt"))).rejects.toThrow();

    await run("git", ["-C", alice, "add", "app.txt"]);
    await run("git", ["-C", alice, "-c", "user.name=Alice", "-c", "user.email=alice@example.test", "commit", "--quiet", "-m", "publish"]);
    await run("git", ["-C", alice, "push", "--quiet", "origin", "main"]);
    await expect(readFile(join(bob, "app.txt"), "utf8")).resolves.toBe("initial\n");
    await run("git", ["-C", bob, "pull", "--quiet", "--ff-only"]);
    await expect(readFile(join(bob, "app.txt"), "utf8")).resolves.toBe("alice private edit\n");
  });
});

function identity(key: string, isAdministrator = true): AuthenticatedIdentity {
  return {
    issuer: "https://identity.example.test",
    subject: key,
    ownerKey: key.repeat(64),
    orgId: TEST_ORG,
    isAdministrator,
    claims: {},
  };
}

function workspace(ownerKey: string, orgId: OrgId) {
  const now = new Date().toISOString();
  return {
    deploymentMode: "ec2-ebs" as const,
    id: crypto.randomUUID(),
    ownerKey,
    orgId,
    projectName: "payments",
    projectRevision: 1,
    environmentDigest: `registry.example.test/worker@sha256:${"a".repeat(64)}`,
    rootPath: "/mnt/workspace" as const,
    status: "READY" as const,
    preparationManifest: ".agentx/preparation-manifest.json",
    activeOperationId: null,
    fence: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function projectDefinition(): ProjectDefinition {
  return {
    name: "payments",
    revision: 1,
    repositories: [
      {
        name: "payments",
        url: "https://git.example.test/payments.git",
        path: "repo/payments",
        defaultBranch: "main",
        credentialRef: "payments-readwrite",
      },
    ],
    setup: [],
    readiness: [],
    orchestratorInstructions: "Delegate coding remotely.",
  };
}
