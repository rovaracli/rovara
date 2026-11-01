// Enterprise foundations P5e: the broker's route side and wiring reach a repository's code host by the repository's RECORD (task P7). What the port carries is moved (the attribution rewrite on a
// change request); what it cannot carry yet (the meta repository's head and capped file reads, the session change list, the setup agent's citation reads) stays GitHub's and is refused, with a
// fixed sentence, for a repository on any other host; a record that names a host this install has not registered is refused with the router's sentence. Nothing is asked of GitHub for it.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { editionPolicy } from "../../packages/contracts/src/index.js";
import { rewriteDescriptionsOfTask, attributionErasureOf } from "../../packages/broker/src/aws/broker/attribution-erasure.js";
import { metaRepositoryReaders } from "../../packages/broker/src/aws/broker/meta-repo-wiring.js";
import { metaPrepareOf } from "../../packages/broker/src/aws/broker/workspace-preparation.js";
import { NO_HOST_MESSAGE } from "../../packages/broker/src/plugins/registry.js";
import { GITHUB_ONLY_MESSAGE } from "../../packages/broker/src/plugins/code-host/github-only.js";
import { agentSessionKey, sanitizeSetupProposal, type SetupProposal } from "@agentx/contracts";
import { verificationOf } from "../../packages/broker/src/rovara-code/setup-draft.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { createPluginRegistry } from "../../packages/broker/src/plugins/registry.js";
import { sessionWorld } from "../support/agent-session-world.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { pullRequestDetails, type TestRepository } from "../support/p5-world.js";
import { FAKE_META_URL, FAKE_URL, GITHUB_META_URL, GITHUB_URL, MYSTERY_URL, SCOPE, TASK, WORKSPACE, refusal, world } from "../support/p5-host-world.js";

describe("P5e: erasing a person from the attribution a change request carries", () => {
  const BODY = "Summary\nRequested by: Maya Chen\nPlan approved by: Priya Raman\n";
  function erasureWorld(repository: string, url: string) {
    const w = world();
    w.model.commit("agentx/x", { "e.txt": "1" });
    const cr = w.model.reconcile({ sourceBranch: "agentx/x", targetBranch: "main", title: "t", body: BODY }).cr;
    w.db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: `PULL_REQUEST#${repository}#${cr.id.padStart(12, "0")}`, entityType: "PULL_REQUEST", repository, repositoryUrl: url, number: Number(cr.id), body: BODY });
    return { ...w, cr };
  }

  it("rewrites the description on the fake host the record names, and in the broker's copy; GitHub is not asked", async () => {
    const w = erasureWorld("api", FAKE_URL);
    await rewriteDescriptionsOfTask(w.dependencies, TASK, "requester");
    expect(w.cr.body).toBe("Summary\nRequested by: a former member\nPlan approved by: Priya Raman\n");
    expect(w.github.getPullRequest).not.toHaveBeenCalled();
    expect(w.github.updatePullRequest).not.toHaveBeenCalled();
    // Repeatable: a description that no longer names them is not written again.
    const before = w.cr.body;
    await rewriteDescriptionsOfTask(w.dependencies, TASK, "requester");
    expect(w.cr.body).toBe(before);
  });

  it("refuses a record that names a host this install has not registered: the erasure fails (the person's rows are kept, and it is retried), and nothing is written anywhere", async () => {
    const w = erasureWorld("mystery", MYSTERY_URL);
    await expect(rewriteDescriptionsOfTask(w.dependencies, TASK, "requester")).rejects.toThrow(refusal(NO_HOST_MESSAGE));
    expect(w.github.getPullRequest).not.toHaveBeenCalled();
    expect(w.github.updatePullRequest).not.toHaveBeenCalled();
    expect(w.cr.body).toBe(BODY);
  });

  it("still goes to GitHub for a GitHub record", async () => {
    const w = erasureWorld("web", GITHUB_URL);
    w.github.getPullRequest.mockResolvedValue(pullRequestDetails(1, { body: BODY }));
    await rewriteDescriptionsOfTask(w.dependencies, TASK, "approver");
    expect(w.github.updatePullRequest).toHaveBeenCalledWith(GITHUB_URL, expect.any(Number), { body: "Summary\nRequested by: Maya Chen\nPlan approved by: a former member\n" }, SCOPE);
  });

  it("is the port the Team record's erase calls", () => {
    expect(typeof attributionErasureOf(world().dependencies).erase).toBe("function");
  });
});

describe("P5e: the meta repository reads that the port cannot carry yet stay GitHub's alone", () => {
  it("the config import's two reads (a capped file, the default branch head) are asked of GitHub for a GitHub meta repository", async () => {
    const w = world();
    const readers = metaRepositoryReaders(w.dependencies);
    await expect(readers.getHead({ orgId: TEST_ORG, project: "demo", repository: { name: "web-meta", url: GITHUB_META_URL, defaultBranch: "main" } })).resolves.toBe("a".repeat(40));
    await expect(readers.readMetaFile({ orgId: TEST_ORG, project: "demo", repository: { name: "web-meta", url: GITHUB_META_URL }, commit: "a".repeat(40), path: ".rovara/project.yaml" })).resolves.toBe("file");
  });

  it("refuses a meta repository on another host, or on an unknown one, with the fixed sentences, and never asks GitHub", async () => {
    const w = world();
    const readers = metaRepositoryReaders(w.dependencies);
    const input = (name: string, url: string) => ({ orgId: TEST_ORG, project: "demo", repository: { name, url, defaultBranch: "main" } });
    await expect(readers.getHead(input("api-meta", FAKE_META_URL))).rejects.toThrow(refusal(GITHUB_ONLY_MESSAGE));
    await expect(readers.readMetaFile({ ...input("api-meta", FAKE_META_URL), commit: "a".repeat(40), path: "x" })).rejects.toThrow(refusal(GITHUB_ONLY_MESSAGE));
    await expect(readers.getHead(input("mystery", MYSTERY_URL))).rejects.toThrow(refusal(NO_HOST_MESSAGE));
    expect(w.github.getDefaultBranchHead).not.toHaveBeenCalled();
    expect(w.github.getFileAtCommit).not.toHaveBeenCalled();
  });

  it("pinning the meta repository's head for a new workspace: GitHub's meta repository is read; another host's is refused in its own words, not as 'cannot read just now'", async () => {
    const withMeta = (repositories: TestRepository[]) => world({ repositories });
    const github = withMeta([{ name: "web", url: GITHUB_URL }, { name: "web-meta", url: GITHUB_META_URL, role: "meta" }]);
    const project = github.db.get(`PROJECT#${TEST_ORG}#demo`, "REVISION#000000000001") ?? github.db.find((item) => item.entityType === "PROJECT")[0]!;
    await expect(metaPrepareOf(github.dependencies as never, project as never, TEST_ORG)).resolves.toMatchObject({ knowledgeCommit: "a".repeat(40) });
    const other = withMeta([{ name: "api", url: FAKE_URL, host: { kind: "fake" } }, { name: "api-meta", url: FAKE_META_URL, role: "meta", host: { kind: "fake" } }]);
    await expect(metaPrepareOf(other.dependencies as never, other.db.find((item) => item.entityType === "PROJECT")[0] as never, TEST_ORG)).rejects.toThrow(refusal(GITHUB_ONLY_MESSAGE));
    const unknown = withMeta([{ name: "m", url: MYSTERY_URL, role: "meta", host: { kind: "gitfarm" } }, { name: "c", url: GITHUB_URL }]);
    await expect(metaPrepareOf(unknown.dependencies as never, unknown.db.find((item) => item.entityType === "PROJECT")[0] as never, TEST_ORG)).rejects.toThrow(refusal(NO_HOST_MESSAGE));
    expect(other.github.getDefaultBranchHead).not.toHaveBeenCalled();
    expect(unknown.github.getDefaultBranchHead).not.toHaveBeenCalled();
  });
});


describe("P5e: the change list of a session's pull request", () => {
  // The session diff route reads GitHub's pull request files; the port does not carry them in GitHub's shape yet (left for P6). So the repository's record decides before anything is read.
  async function sessionRoute() {
    const listPullRequestFiles = vi.fn(async () => ({ files: [{ filename: "src/fix.ts", status: "added", additions: 1, deletions: 0, patch: "+fixed" }] }));
    const github = { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), verifyWebhookRepository: vi.fn(), listPullRequestFiles };
    const model = new FakeHostModel({ url: GITHUB_URL, id: "9", fullName: "example/demo" });
    const registry = createPluginRegistry({ codeHosts: [githubCodeHost(github as never, { credentialRef: "github-app" }), new FakeCodeHost(model)], checkRunners: [], policy: editionPolicy("enterprise") });
    const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {}, cloud: true, githubPullRequests: github, codeHost: registry.codeHost } });
    const world = sessionWorld(), seeded = world.seedSession({ owner: MAYA.developerId, orgId: TEST_ORG, project: "payments" });
    const task: Record<string, unknown> = { ...world.db.get("DEVTASK#" + seeded.taskId, "META")!, startingRevision: 1 };
    h.db.set(task);
    h.db.set({ ...agentSessionKey(TEST_ORG, seeded.sessionId, "META"), entityType: "AGENT_SESSION", ...seeded.record });
    h.db.set({ pk: "WORKSPACE#" + String(task.workspaceId), sk: "PULL_REQUEST#demo#42", repository: "demo", number: 42, url: "https://github.com/example/demo/pull/42", state: "open" });
    const browserId = randomUUID();
    h.db.set({ ...h.db.get("SESSION#" + MAYA.sessionId, "META")!, pk: "SESSION#" + browserId, sessionId: browserId, reviewExpiresAt: Math.floor(Date.now() / 1000) + 3600 });
    const setHost = (host: { kind: string } | undefined) => {
      for (const project of h.db.find((item) => item.entityType === "PROJECT")) {
        const definition = project.definition as { repositories: Array<Record<string, unknown>> };
        h.db.set({ ...project, definition: { ...definition, repositories: definition.repositories.map((repository) => {
          const { installationId, githubRepositoryId, host: previous, ...rest } = repository;
          void installationId; void githubRepositoryId; void previous;
          return host === undefined ? repository : { ...rest, host };
        }) } });
      }
    };
    const read = async () => {
      const response = await h.handler({ rawPath: "/v1/web/sessions/" + seeded.sessionId + "/diff", rawQueryString: "repository=demo&number=42&page=1", routeKey: "ANY /v1/web/{proxy+}", headers: { cookie: "__Host-agentx_review_session=" + browserId, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "x-requested-with": "agentx-web" }, requestContext: { http: { method: "GET" } } });
      return { status: response.statusCode, body: JSON.parse(response.body) as { error?: { message: string }; files?: unknown[] } };
    };
    return { read, setHost, listPullRequestFiles };
  }

  it("is read for a GitHub repository (the record names GitHub, or names no host)", async () => {
    const t = await sessionRoute();
    const response = await t.read();
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.files).toHaveLength(1);
    expect(t.listPullRequestFiles).toHaveBeenCalledTimes(1);
  });

  it("is refused, with the fixed sentence and without asking GitHub, for a repository on another registered host", async () => {
    const t = await sessionRoute();
    t.setHost({ kind: "fake" });
    const response = await t.read();
    expect(response.status).toBe(400);
    expect(response.body.error?.message).toContain(GITHUB_ONLY_MESSAGE);
    expect(t.listPullRequestFiles).not.toHaveBeenCalled();
  });

  it("is refused with the router's sentence for a repository whose host this install has not registered", async () => {
    const t = await sessionRoute();
    t.setHost({ kind: "gitfarm" });
    const response = await t.read();
    expect(response.status).toBe(400);
    expect(response.body.error?.message).toContain(NO_HOST_MESSAGE);
    expect(response.body.error?.message).not.toContain("gitfarm");
    expect(t.listPullRequestFiles).not.toHaveBeenCalled();
  });
});

describe("P5e: the setup agent's citations are re-read only from GitHub", () => {
  const COMMIT = "a".repeat(40);
  const context = { basedOnRevision: 1, repositories: [{ name: "web" }, { name: "api" }, { name: "mystery" }] };
  const cite = (repo: string) => ({ kind: "file", repo, path: "package.json", commit: COMMIT, line: 1, quote: "run the tests" });
  const proposal = (): SetupProposal => {
    const read = sanitizeSetupProposal({
      setup: [{ repo: "web", commands: ["run the tests"], from: [cite("web")] }],
      tests: [{ repo: "api", commands: ["run the tests"], from: [cite("api")] }],
      checks: [{ name: "lint", repo: "mystery", command: "run the tests", from: [cite("mystery")] }],
    }, context);
    if (!read.ok) throw new Error(read.errors.join("; "));
    return read.proposal;
  };

  it("reads a GitHub repository's citations, and leaves another host's, and an unknown one's, unchecked without asking GitHub for them", async () => {
    const w = world({ repositories: [{ name: "web", url: GITHUB_URL }, { name: "api", url: FAKE_URL, host: { kind: "fake" } }, { name: "mystery", url: MYSTERY_URL, host: { kind: "gitfarm" } }] });
    const readFile = vi.fn(async () => "run the tests\n");
    const definition = (w.db.find((item) => item.entityType === "PROJECT")[0] as { definition: never }).definition;
    const deps = { documentClient: w.db, tableName: "state", now: () => Date.parse("2026-11-01T00:00:00.000Z"), readFile } as never;
    const result = await verificationOf(deps, { orgId: TEST_ORG } as never, definition, { project: "demo", taskId: TASK } as never, proposal());
    expect(result["setup-web"]).toBe("verified");
    expect(result["tests-api"]).toBe("unchecked");
    expect(result["check-mystery-lint"]).toBe("unchecked");
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith(TEST_ORG, GITHUB_URL, "package.json", COMMIT, expect.anything());
  });
});
