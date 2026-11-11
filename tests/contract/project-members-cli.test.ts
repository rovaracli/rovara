// Plan 2, Task 21: `agentx project members | add-member | remove-member` against a fake control plane (the requests each sends and the lines each
// prints), and the four forms `agentx whoami` prints for a project.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeveloperProject } from "@rovara-code/contracts";
import type { DeveloperProjectsResponse } from "@agentx/cloud-contracts";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { whoamiText } from "../../packages/cli/src/developer/commands.js";
import { createCliProgram, executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const URL_ = "https://abc123.execute-api.us-west-2.amazonaws.com";
const ISSUER = `${URL_}/v1/auth`;
const entry = { url: URL_, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRIYA = "1".repeat(64);
const SAM = "2".repeat(64);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const orgMembers = {
  members: [
    { developerId: PRIYA, name: "Priya Raman", email: "priya@example.com", role: "member", joinedAt: "2026-10-01T00:00:00.000Z", identities: ["cloud"] },
    { developerId: SAM, name: "Sam Okoye", email: "sam@example.com", role: "member", joinedAt: "2026-10-02T00:00:00.000Z", identities: ["github"] },
  ],
};
const projectMembers = {
  members: [
    { developerId: PRIYA, name: "Priya Raman", email: "priya@example.com", role: "maintainer", source: "grant", grantedBy: { developerId: PRIYA, name: "Priya Raman" } },
    { developerId: "3".repeat(64), name: "Lena Fischer", role: "maintainer", source: "org_role" },
    { developerId: SAM, name: "Sam Okoye", email: "sam@example.com", role: "viewer", source: "grant", grantedBy: { developerId: PRIYA, name: "Priya Raman" } },
    { developerId: "4".repeat(64), name: "Kit Alvarez", role: "contributor", source: "grant" },
  ],
};

async function cli(answer: (method: string, path: string) => Response) {
  const home = await mkdtemp(join(tmpdir(), "rovara-project-members-cli-"));
  dirs.push(home);
  await saveDeveloperEnvironment(home, "staging", entry);
  const tokenStore = new InMemoryTokenStore();
  await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "access", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<{ method: string; path: string; authorization: string | null; body: unknown }> = [];
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    const method = init?.method ?? "GET";
    calls.push({ method, path, authorization: new Headers(init?.headers).get("authorization"), body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined });
    return answer(method, path);
  });
  const run = (argv: string[]) => executeCli(argv, {
    fetchImplementation, tokenStore, environments: { home },
    stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) },
  });
  return { run, out, err, calls };
}

const routes = (overrides: Record<string, Response> = {}) => (method: string, path: string): Response => {
  const key = `${method} ${path}`;
  const override = overrides[key];
  if (override !== undefined) return override;
  if (key === "GET /v1/app/org/members") return Response.json(orgMembers);
  if (key === "GET /v1/app/projects/web/members") return Response.json(projectMembers);
  return Response.json({ error: { code: "NOT_FOUND", message: `NOT_FOUND: ${key}` } }, { status: 404 });
};

describe("agentx project members", () => {
  it("asks the control plane for the project's members with the developer session and prints each person, role and where it comes from", async () => {
    const h = await cli(routes());
    expect(await h.run(["project", "members", "web"])).toBe(0);
    expect(h.calls).toEqual([{ method: "GET", path: "/v1/app/projects/web/members", authorization: "Bearer access", body: undefined }]);
    expect(h.out.join("")).toBe([
      "People in web on staging (" + URL_ + "):",
      "  Priya Raman <priya@example.com>  maintainer  (added by Priya Raman)",
      "  Lena Fischer  maintainer  (org owner or admin)",
      "  Sam Okoye <sam@example.com>  viewer  (added by Priya Raman)",
      "  Kit Alvarez  contributor  (added by an admin)",
      "",
    ].join("\n"));
  });

  it("--json prints the members", async () => {
    const h = await cli(routes());
    expect(await h.run(["--json", "project", "members", "web"])).toBe(0);
    expect(JSON.parse(h.out.join(""))).toMatchObject({ ok: true, data: { members: [{ developerId: PRIYA, role: "maintainer", source: "grant" }, expect.anything(), expect.anything(), expect.anything()] } });
  });

  it("shows the server's words when the project is not found, and encodes the name in the path", async () => {
    const h = await cli(() => Response.json({ error: { code: "PROJECT_NOT_FOUND", message: "PROJECT_NOT_FOUND: project not found" } }, { status: 404 }));
    expect(await h.run(["project", "members", "we b"])).not.toBe(0);
    expect(h.calls[0]!.path).toBe("/v1/app/projects/we%20b/members");
    expect(h.err.join("")).toContain("project not found");
  });
});

describe("agentx project add-member", () => {
  it("finds the person by email in the org's people, then puts their role with a fresh request id", async () => {
    const h = await cli(routes({ [`PUT /v1/app/projects/web/members/${SAM}`]: Response.json({ member: { developerId: SAM, role: "contributor" }, requestId: "r" }) }));
    expect(await h.run(["project", "add-member", "web", "Sam@Example.com", "--role", "contributor"])).toBe(0);
    expect(h.calls).toEqual([
      { method: "GET", path: "/v1/app/org/members", authorization: "Bearer access", body: undefined },
      { method: "PUT", path: `/v1/app/projects/web/members/${SAM}`, authorization: "Bearer access", body: { requestId: expect.stringMatching(UUID) as string, role: "contributor" } },
    ]);
    expect(h.out.join("")).toBe("Sam Okoye is now a contributor in web.\n");
  });

  it("takes a developer id too, and says 'a maintainer' and 'a viewer'", async () => {
    const h = await cli(routes({
      [`PUT /v1/app/projects/web/members/${PRIYA}`]: Response.json({ member: { developerId: PRIYA, role: "maintainer" } }),
      [`PUT /v1/app/projects/web/members/${SAM}`]: Response.json({ member: { developerId: SAM, role: "viewer" } }),
    }));
    expect(await h.run(["project", "add-member", "web", PRIYA, "--role", "maintainer"])).toBe(0);
    expect(await h.run(["project", "add-member", "web", SAM, "--role", "viewer"])).toBe(0);
    expect(h.out.join("")).toBe("Priya Raman is now a maintainer in web.\nSam Okoye is now a viewer in web.\n");
  });

  it("needs --role, and only maintainer, contributor or viewer; nothing is sent", async () => {
    const h = await cli(routes());
    // The argument parser words these refusals itself, on the process's own stderr.
    const refusals: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((text: string | Uint8Array) => { refusals.push(String(text)); return true; });
    try {
      expect(await h.run(["project", "add-member", "web", "sam@example.com"])).not.toBe(0);
      expect(await h.run(["project", "add-member", "web", "sam@example.com", "--role", "owner"])).not.toBe(0);
      expect(await h.run(["project", "add-member", "web", "sam@example.com", "--role", "developer"])).not.toBe(0);
    } finally {
      stderr.mockRestore();
    }
    expect(refusals.join("")).toContain("required option '--role <role>' not specified");
    expect(refusals.join("")).toContain("Allowed choices are maintainer, contributor, viewer");
    expect(h.calls).toEqual([]);
  });

  it("stops when no one in the org has that email or id, before any change", async () => {
    const h = await cli(routes());
    expect(await h.run(["project", "add-member", "web", "nobody@example.com", "--role", "viewer"])).not.toBe(0);
    expect(h.calls.map((call) => call.method)).toEqual(["GET"]);
    expect(h.err.join("")).toContain("no member of your organization has the email or ID nobody@example.com");
  });

  it("shows the server's words when it refuses (a contributor may not, an owner takes no role)", async () => {
    const forbidden = "only a project maintainer can change who is in a project";
    let h = await cli(routes({ [`PUT /v1/app/projects/web/members/${SAM}`]: Response.json({ error: { code: "FORBIDDEN", message: `FORBIDDEN: ${forbidden}` } }, { status: 403 }) }));
    expect(await h.run(["project", "add-member", "web", SAM, "--role", "viewer"])).not.toBe(0);
    expect(h.err.join("")).toContain(forbidden);
    h = await cli(routes({ [`PUT /v1/app/projects/web/members/${SAM}`]: Response.json({ error: { code: "CONFIG_INVALID", message: "CONFIG_INVALID: owners and admins already maintain every project" } }, { status: 400 }) }));
    expect(await h.run(["project", "add-member", "web", SAM, "--role", "viewer"])).not.toBe(0);
    expect(h.err.join("")).toContain("owners and admins already maintain every project");
  });

  it("--json prints the member", async () => {
    const h = await cli(routes({ [`PUT /v1/app/projects/web/members/${SAM}`]: Response.json({ member: { developerId: SAM, role: "viewer" } }) }));
    expect(await h.run(["--json", "project", "add-member", "web", SAM, "--role", "viewer"])).toBe(0);
    expect(JSON.parse(h.out.join(""))).toMatchObject({ ok: true, data: { member: { developerId: SAM, role: "viewer" } } });
  });
});

describe("agentx project remove-member", () => {
  it("finds the person, deletes their role with a request id in the body, and says so", async () => {
    const h = await cli(routes({ [`DELETE /v1/app/projects/web/members/${SAM}`]: Response.json({ developerId: SAM, removed: true }) }));
    expect(await h.run(["project", "remove-member", "web", "sam@example.com"])).toBe(0);
    expect(h.calls).toEqual([
      { method: "GET", path: "/v1/app/org/members", authorization: "Bearer access", body: undefined },
      { method: "DELETE", path: `/v1/app/projects/web/members/${SAM}`, authorization: "Bearer access", body: { requestId: expect.stringMatching(UUID) as string } },
    ]);
    expect(h.out.join("")).toBe("Removed Sam Okoye from web.\n");
  });

  it("says nothing changed for a person with no role in the project", async () => {
    const h = await cli(routes({ [`DELETE /v1/app/projects/web/members/${SAM}`]: Response.json({ developerId: SAM, removed: false }) }));
    expect(await h.run(["project", "remove-member", "web", SAM])).toBe(0);
    expect(h.out.join("")).toBe("Sam Okoye had no role in web; nothing changed.\n");
  });

  it("shows the server's words when it refuses", async () => {
    const h = await cli(routes({ [`DELETE /v1/app/projects/web/members/${SAM}`]: Response.json({ error: { code: "FORBIDDEN", message: "FORBIDDEN: only a project maintainer can change who is in a project" } }, { status: 403 }) }));
    expect(await h.run(["project", "remove-member", "web", SAM])).not.toBe(0);
    expect(h.err.join("")).toContain("only a project maintainer can change who is in a project");
  });
});

describe("the project commands", () => {
  it("lists members, add-member and remove-member under `project`", () => {
    const names = createCliProgram().commands.find((command) => command.name() === "project")!.commands.map((command) => command.name());
    expect(names).toEqual(expect.arrayContaining(["members", "add-member", "remove-member"]));
  });
});

describe("whoamiText: each project says what you are in it, and why", () => {
  const developer = (orgRole: "owner" | "admin" | "member" = "member"): DeveloperProjectsResponse["developer"] => ({ id: PRIYA, name: "Priya Raman", provider: "cloud", orgRole });
  const project = (extra: Partial<DeveloperProject>): DeveloperProject => ({ name: "web", latestRevision: 1, access: "granted", channels: [], ...extra });
  const text = (orgRole: "owner" | "admin" | "member", ...projects: DeveloperProject[]) => whoamiText({ env: "staging", url: URL_, projects: { developer: developer(orgRole), projects, notices: [] } });

  it("web: maintainer (you created it), when you made your own grant", () => {
    expect(text("member", project({ role: "maintainer", roleSource: "grant", addedBy: { developerId: PRIYA, name: "Priya Raman" } }))).toContain("Projects you can use:\n  web: maintainer (you created it)\n");
  });

  it("web: <role> (added by <name>), when someone else added you", () => {
    const by = { developerId: SAM, name: "Sam Okoye" };
    expect(text("member", project({ role: "contributor", roleSource: "grant", addedBy: by }))).toContain("  web: contributor (added by Sam Okoye)\n");
    expect(text("member", project({ role: "viewer", roleSource: "grant", addedBy: by }))).toContain("  web: viewer (added by Sam Okoye)\n");
    expect(text("member", project({ role: "maintainer", roleSource: "grant", addedBy: by }))).toContain("  web: maintainer (added by Sam Okoye)\n");
  });

  it("web: maintainer (as org owner) or (as org admin)", () => {
    expect(text("owner", project({ role: "maintainer", roleSource: "org_role" }))).toContain("  web: maintainer (as org owner)\n");
    expect(text("admin", project({ role: "maintainer", roleSource: "org_role" }))).toContain("  web: maintainer (as org admin)\n");
  });

  it("web: contributor (through #channel), naming public channels and giving a private one by id", () => {
    const channels = [{ channelId: "C0123456789", name: "web-dev", isPrivate: false }, { channelId: "C0999999999", isPrivate: true }];
    expect(text("member", project({ access: "channel", role: "contributor", roleSource: "channel", channels }))).toContain("  web: contributor (through #web-dev, C0999999999)\n");
  });

  it("says 'added by an admin' for a grant the operator console made, and 'added by you' when you lowered your own role", () => {
    expect(text("member", project({ role: "contributor", roleSource: "grant" }))).toContain("  web: contributor (added by an admin)\n");
    expect(text("member", project({ role: "viewer", roleSource: "grant", addedBy: { developerId: PRIYA, name: "Priya Raman" } }))).toContain("  web: viewer (added by you)\n");
  });

  it("never says 'an admin granted you access' any more", () => {
    expect(text("member", project({ role: "contributor", roleSource: "grant" }))).not.toContain("an admin granted you access");
  });

  it("keeps listing a project from an older control plane, which sends no role", () => {
    expect(text("member", project({}))).toContain("  web: you have access\n");
    expect(text("member", project({ access: "channel", channels: [{ channelId: "C0123456789", name: "web-dev" }] }))).toContain("  web: through #web-dev\n");
  });

  it("makes server text safe to show", () => {
    expect(text("member", project({ role: "contributor", roleSource: "grant", addedBy: { developerId: SAM, name: "Sam\u001b[31m Okoye" } }))).not.toContain("\u001b");
  });
});
