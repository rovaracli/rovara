// Task 23: `agentx project create` (a cloud org's owner or admin creates a project) and the whoami wording for Rovara Cloud sign-ins.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeveloperProjectsResponse } from "@agentx/cloud-contracts";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { whoamiText } from "../../packages/cli/src/developer/commands.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const URL_ = "https://abc123.execute-api.us-west-2.amazonaws.com";
const ISSUER = `${URL_}/v1/auth`;
const entry = { url: URL_, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };
const urlOf = (input: string | URL | Request) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function signedIn(answer: () => Response) {
  const home = await mkdtemp(join(tmpdir(), "agentx-project-create-"));
  dirs.push(home);
  await saveDeveloperEnvironment(home, "staging", entry);
  const tokenStore = new InMemoryTokenStore();
  await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "access", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  const out: string[] = [];
  const err: string[] = [];
  const requests: Array<{ method?: string; path: string; authorization: string | null; body: unknown }> = [];
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    requests.push({ ...(init?.method === undefined ? {} : { method: init.method }), path: new URL(urlOf(input)).pathname, authorization: new Headers(init?.headers).get("authorization"), body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined });
    return answer();
  });
  const run = (argv: string[]) => executeCli(argv, { fetchImplementation, tokenStore, environments: { home }, stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } });
  return { out, err, run, requests, fetchImplementation };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const created = (duplicate = false) => Response.json({ duplicate, project: { definition: { name: "web", revision: 1 }, runtimeBinding: {} } }, { status: duplicate ? 200 : 201 });

describe("agentx project create", () => {
  it("sends a request id and the repository to POST /v1/app/projects with the developer session, and prints the project and the next step", async () => {
    const h = await signedIn(created);
    expect(await h.run(["project", "create", "--repository", "acme/web"])).toBe(0);
    expect(h.requests).toEqual([{ method: "POST", path: "/v1/app/projects", authorization: "Bearer access", body: { requestId: expect.stringMatching(UUID) as string, repository: "acme/web" } }]);
    expect(h.out.join("")).toBe([
      "Created project web in AgentX environment staging. You have access to it.",
      "Next: start a task in web from your coding tool (agentx mcp install connects it), or run agentx whoami to see your projects.",
      "",
    ].join("\n"));
    expect(h.err.join("")).toBe("");
  });

  it("sends the name, description and commands when given", async () => {
    const h = await signedIn(created);
    expect(await h.run(["project", "create", "--repository", "acme/web", "--name", "web-app", "--description", "The web app.", "--setup-command", "npm ci", "--test-command", "npm test"])).toBe(0);
    expect(h.requests[0]?.body).toEqual({ requestId: expect.stringMatching(UUID) as string, repository: "acme/web", name: "web-app", description: "The web app.", setupCommand: "npm ci", testCommand: "npm test" });
  });

  it("keeps every repeated --test-command and --setup-command, in the order they were given (blind test 02: only the last test command was kept)", async () => {
    const h = await signedIn(created);
    expect(await h.run(["project", "create", "--repository", "acme/web", "--setup-command", "pip install -r requirements.txt", "--setup-command", "npm ci", "--test-command", "python3 -m ruff check .", "--test-command", "python3 -m pytest"])).toBe(0);
    expect(h.requests[0]?.body).toEqual({
      requestId: expect.stringMatching(UUID) as string, repository: "acme/web",
      setupCommands: ["pip install -r requirements.txt", "npm ci"], testCommands: ["python3 -m ruff check .", "python3 -m pytest"],
    });
  });

  it("still sends one command as testCommand, so an older control plane reads it", async () => {
    const h = await signedIn(created);
    expect(await h.run(["project", "create", "--repository", "acme/web", "--test-command", "npm test"])).toBe(0);
    expect(h.requests[0]?.body).toEqual({ requestId: expect.stringMatching(UUID) as string, repository: "acme/web", testCommand: "npm test" });
  });

  it("sends a new request id for each command, so a second project is not a replay", async () => {
    const h = await signedIn(created);
    expect(await h.run(["project", "create", "--repository", "acme/web"])).toBe(0);
    expect(await h.run(["project", "create", "--repository", "acme/web"])).toBe(0);
    const ids = h.requests.map((request) => (request.body as { requestId: string }).requestId);
    expect(new Set(ids).size).toBe(2);
  });

  it("sends an empty command as given, so a person can say there is none", async () => {
    const h = await signedIn(created);
    expect(await h.run(["project", "create", "--repository", "acme/web", "--setup-command", ""])).toBe(0);
    expect(h.requests[0]?.body).toEqual({ requestId: expect.stringMatching(UUID) as string, repository: "acme/web", setupCommand: "" });
  });

  it("says the project already exists when the same project is created again", async () => {
    const h = await signedIn(() => created(true));
    expect(await h.run(["project", "create", "--repository", "acme/web"])).toBe(0);
    expect(h.out.join("")).toContain("Project web already exists in AgentX environment staging with these settings. You have access to it.");
  });

  it("--json prints the broker's answer", async () => {
    const h = await signedIn(created);
    expect(await h.run(["--json", "project", "create", "--repository", "acme/web"])).toBe(0);
    expect(JSON.parse(h.out.join(""))).toEqual({ ok: true, data: { env: "staging", url: URL_, duplicate: false, project: { name: "web", revision: 1 } } });
  });

  it("shows the server's reason when it refuses", async () => {
    const h = await signedIn(() => Response.json({ error: { code: "FORBIDDEN", message: "Rovara can't reach acme/web through your organization's GitHub connection. Connect it with: agentx github connect" } }, { status: 403 }));
    expect(await h.run(["project", "create", "--repository", "acme/web"])).not.toBe(0);
    expect(h.err.join("")).toContain("Connect it with: agentx github connect");
  });

  it("asks for the repository before calling anything", async () => {
    const h = await signedIn(created);
    expect(await h.run(["project", "create"])).not.toBe(0);
    expect(h.err.join("")).toContain("CONFIG_INVALID");
    expect(h.err.join("")).toContain("--repository <owner/name>");
    expect(h.fetchImplementation).not.toHaveBeenCalled();
  });
});

describe("whoamiText", () => {
  const developer = (provider: DeveloperProjectsResponse["developer"]["provider"], orgRole?: "owner" | "admin" | "member"): DeveloperProjectsResponse["developer"] => ({ id: "a".repeat(64), name: "Maya Chen", provider, ...(orgRole === undefined ? {} : { orgRole }) });
  const text = (provider: DeveloperProjectsResponse["developer"]["provider"], orgRole?: "owner" | "admin" | "member", projects: DeveloperProjectsResponse["projects"] = []) =>
    whoamiText({ env: "staging", url: URL_, projects: { developer: developer(provider, orgRole), projects, notices: [] } });

  it("names the sign-in: Rovara sign-in, GitHub, Slack, or the company's", () => {
    expect(text("cloud", "owner")).toContain("as Maya Chen, with Rovara sign-in.");
    expect(text("github", "owner")).toContain("as Maya Chen, with GitHub.");
    expect(text("slack")).toContain("as Maya Chen, with Slack.");
    expect(text("oidc")).toContain("as Maya Chen, with your company sign-in.");
  });

  it("tells an owner or admin of a cloud org with no projects how to create one", () => {
    for (const provider of ["cloud", "github"] as const) {
      for (const role of ["owner", "admin"] as const) {
        expect(text(provider, role)).toContain("Connect GitHub with agentx github connect, then: agentx project create --repository <owner/name>");
      }
    }
  });

  it("tells a member of a cloud org with no projects to ask the org's owner", () => {
    for (const provider of ["cloud", "github"] as const) {
      const member = text(provider, "member");
      expect(member).toContain("ask your org's owner to create one");
      expect(member).not.toContain("agentx project create");
    }
  });

  it("keeps the Slack and company sign-in wording for no projects as it was", () => {
    for (const provider of ["slack", "oidc"] as const) {
      expect(text(provider, "owner")).toContain("You cannot use any project yet: join a project's Slack channel, or ask an admin for access.");
      expect(text(provider, "owner")).not.toContain("agentx project create");
    }
  });

  it("lists projects as it did, and adds no creation hint when there are some", () => {
    const listed = text("cloud", "owner", [{ name: "web", latestRevision: 1, access: "granted", channels: [], role: "maintainer", roleSource: "org_role" }]);
    expect(listed).toContain("Projects you can use:\n  web: maintainer (as org owner)");
    expect(listed).not.toContain("agentx project create");
  });
});
