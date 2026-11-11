// Plan 2, Task 6: `agentx login --invite <link>`. Reading the three kinds of invite link, finding the cell, the question asked before a
// browser opens (ruling R19), the invite riding the authorize URL, and the exact words for every way the invite can end.
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INVITE_WRONG_EMAIL_MESSAGE } from "@rovara-code/contracts";
import { ROVARA_DIRECTORY_ORIGIN, inviteOutcomeText, parseInviteLink, resolveInviteCell } from "../../packages/cli/src/developer/invite-link.js";
import { readDeveloperConfig } from "../../packages/cli/src/developer/config.js";
import { developerLogin } from "../../packages/cli/src/developer/login.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";

const TOKEN = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U-_";
const CELL = "https://abc.execute-api.us-west-2.amazonaws.com";
const ISSUER = `${CELL}/v1/auth`;
const REFRESH = `agxr_${"r".repeat(43)}`;
const configuration = {
  env: "staging", apiVersion: "1.0", issuer: ISSUER, authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`,
  revocationEndpoint: `${ISSUER}/revoke`, clientId: "agentx-cli", methods: { slack: false, oidc: null, cloud: { displayName: "Rovara" }, github: null },
};
const urlOf = (input: string | URL | Request) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

describe("parseInviteLink", () => {
  it("reads the rovara.dev link with the invite in the fragment, and the older one with it in the query", () => {
    expect(parseInviteLink(`https://rovara.dev/join#invite=${TOKEN}`)).toEqual({ token: TOKEN, directoryOrigin: ROVARA_DIRECTORY_ORIGIN });
    expect(parseInviteLink(`https://rovara.dev/join/#invite=${TOKEN}`)).toEqual({ token: TOKEN, directoryOrigin: ROVARA_DIRECTORY_ORIGIN });
    expect(parseInviteLink(`https://rovara.dev/join?invite=${TOKEN}`)).toEqual({ token: TOKEN, directoryOrigin: ROVARA_DIRECTORY_ORIGIN });
    expect(parseInviteLink(`  https://rovara.dev/join#invite=${TOKEN}\n`).token).toBe(TOKEN);
  });
  it("reads a cell's own join link, keeping a stage path", () => {
    expect(parseInviteLink(`${CELL}/v1/auth/join?invite=${TOKEN}`)).toEqual({ token: TOKEN, cellUrl: CELL });
    expect(parseInviteLink(`${CELL}/v1/auth/join#invite=${TOKEN}`)).toEqual({ token: TOKEN, cellUrl: CELL });
    expect(parseInviteLink(`${CELL}/prod/v1/auth/join?invite=${TOKEN}`)).toEqual({ token: TOKEN, cellUrl: `${CELL}/prod` });
  });
  // UX1 review I1: a cloud cell's own invite page, <app origin>/join, is read as that cell only when the CLI already knows the cell (a saved login, or
  // the URL given); every other host's /join stays refused, look-alikes of a known cell included.
  it("reads a known cell's own /join as that cell, never as the directory, and nothing else", () => {
    const known = ["https://staging.rovara.dev", "https://abc.example/prod"];
    expect(parseInviteLink(`https://staging.rovara.dev/join#invite=${TOKEN}`, known)).toEqual({ token: TOKEN, cellUrl: "https://staging.rovara.dev" });
    expect(parseInviteLink(`https://abc.example/join#invite=${TOKEN}`, known)).toEqual({ token: TOKEN, cellUrl: "https://abc.example" });
    for (const link of [`https://evil.example/join#invite=${TOKEN}`, `https://staging.rovara.dev.evil.example/join#invite=${TOKEN}`, `https://www.staging.rovara.dev/join#invite=${TOKEN}`, `https://staging.rovara.dev:8443/join#invite=${TOKEN}`]) {
      expect(() => parseInviteLink(link, known), link).toThrow("CONFIG_INVALID: that is not a Rovara invite link");
    }
    expect(() => parseInviteLink(`https://staging.rovara.dev/join#invite=${TOKEN}`, ["http://staging.rovara.dev", "not a url"])).toThrow("CONFIG_INVALID: that is not a Rovara invite link");
  });
  it("accepts a bare token with neither", () => {
    expect(parseInviteLink(TOKEN)).toEqual({ token: TOKEN });
  });
  it.each([
    ["another host's /join", `https://evil.example/join#invite=${TOKEN}`],
    ["a subdomain of rovara.dev", `https://www.rovara.dev/join#invite=${TOKEN}`],
    ["rovara.dev with another port", `https://rovara.dev:8443/join#invite=${TOKEN}`],
    ["rovara.dev with a look-alike host", `https://rovara.dev.evil.example/join#invite=${TOKEN}`],
    ["rovara.dev with credentials", `https://rovara.dev@evil.example/join#invite=${TOKEN}`],
    ["plain http", `http://rovara.dev/join#invite=${TOKEN}`],
    ["plain http cell", `http://abc.example/v1/auth/join?invite=${TOKEN}`],
    ["another path on rovara.dev", `https://rovara.dev/other#invite=${TOKEN}`],
    ["the root of rovara.dev", `https://rovara.dev/#invite=${TOKEN}`],
    ["a path that only ends like a join path", `${CELL}/xv1/auth/join?invite=${TOKEN}`],
    ["not a URL", "not a link"],
    ["a short code", "abc"],
    ["a token with a stray character", `${TOKEN.slice(0, 42)}!`],
    ["a javascript URL", "javascript:alert(1)"],
  ])("refuses %s", (_name, link) => {
    expect(() => parseInviteLink(link)).toThrow("CONFIG_INVALID: that is not a Rovara invite link");
  });
  it("says so when a rovara.dev or cell link has no invite in it", () => {
    for (const link of ["https://rovara.dev/join", "https://rovara.dev/join#invite=", `${CELL}/v1/auth/join`]) {
      expect(() => parseInviteLink(link)).toThrow("CONFIG_INVALID: that invite link has no invite in it");
    }
  });
  it("refuses a link whose invite is not the shape of one", () => {
    expect(() => parseInviteLink("https://rovara.dev/join#invite=short")).toThrow("CONFIG_INVALID: that is not a Rovara invite link");
  });
});

describe("resolveInviteCell", () => {
  const cellJson = (body: unknown, status = 200) => vi.fn<typeof fetch>(async () => (status === 200 ? Response.json(body) : new Response("no", { status })));
  it("returns the cell a link names without asking anyone", async () => {
    const fetchImpl = cellJson({});
    expect(await resolveInviteCell({ token: TOKEN, cellUrl: CELL }, fetchImpl)).toBe(CELL);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("reads the directory's cell.json for a rovara.dev link", async () => {
    const fetchImpl = cellJson({ cellUrl: `${CELL}/` });
    expect(await resolveInviteCell({ token: TOKEN, directoryOrigin: ROVARA_DIRECTORY_ORIGIN }, fetchImpl)).toBe(CELL);
    expect(urlOf(fetchImpl.mock.calls[0]![0])).toBe("https://rovara.dev/join/cell.json");
  });
  it.each([["http", "http://evil"], ["a query", "https://x/?a=1"], ["a hash", "https://x/#a"], ["a password", "https://u:p@x"], ["not a URL", "nope"], ["a number", 3]])("refuses a cellUrl with %s", async (_name, cellUrl) => {
    await expect(resolveInviteCell({ token: TOKEN, directoryOrigin: ROVARA_DIRECTORY_ORIGIN }, cellJson({ cellUrl }))).rejects.toThrow("RUNTIME_UNAVAILABLE: Rovara is not reachable from this invite link right now");
  });
  it("refuses a non-https cell named by the link itself", async () => {
    await expect(resolveInviteCell({ token: TOKEN, cellUrl: "http://evil.example" }, cellJson({}))).rejects.toThrow("CONFIG_INVALID: that is not a Rovara invite link");
  });
  it("says Rovara is not reachable when cell.json cannot be read", async () => {
    await expect(resolveInviteCell({ token: TOKEN, directoryOrigin: ROVARA_DIRECTORY_ORIGIN }, cellJson({}, 404))).rejects.toThrow("not reachable");
    await expect(resolveInviteCell({ token: TOKEN, directoryOrigin: ROVARA_DIRECTORY_ORIGIN }, vi.fn<typeof fetch>(async () => { throw new TypeError("fetch failed"); }))).rejects.toThrow("not reachable");
  });
  it("needs an address for a bare token", async () => {
    await expect(resolveInviteCell({ token: TOKEN }, cellJson({}))).rejects.toThrow("CONFIG_INVALID: that invite is only a code");
  });
});

describe("inviteOutcomeText", () => {
  it("has the exact words for each way an invite ends", () => {
    expect(inviteOutcomeText("joined", { name: "Acme", role: "member" })).toBe("You joined Acme as member.");
    expect(inviteOutcomeText("ALREADY_IN_ORG", { name: "Bea's team", role: "owner" })).toBe("You're already in Bea's team. For now, a person can belong to one Rovara organization: sign in with a different email address, or ask an owner of Bea's team to remove you. If Bea's team is a team you made by mistake and no one else is in it, run agentx org leave and try the invite again.");
    expect(inviteOutcomeText("INVITE_WRONG_EMAIL")).toBe(INVITE_WRONG_EMAIL_MESSAGE);
    expect(inviteOutcomeText("INVITE_INVALID")).toBe("That invite can no longer be used; ask for a new one.");
  });
  it("names no organization it could not read, and says so in a sentence that still reads", () => {
    expect(inviteOutcomeText("ALREADY_IN_ORG")).toBe("You're already in another Rovara organization. For now, a person can belong to one Rovara organization: sign in with a different email address, or ask an owner of that organization to remove you. If it is a team you made by mistake and no one else is in it, run agentx org leave and try the invite again.");
    expect(inviteOutcomeText("joined")).toBe("You joined the organization.");
  });
  it("strips terminal escapes from names the server sent", () => {
    expect(inviteOutcomeText("joined", { name: "Ac\u001b[2Jme", role: "member" })).toBe("You joined Ac[2Jme as member.");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

interface World {
  summary?: { status: number; body: unknown };
  directory?: unknown;
  /** What the browser brings back to the loopback besides the code. */
  callback?: Record<string, string>;
  org?: { name: string; role: string } | "fails";
  cell?: string;
}

async function world(options: World = {}, confirm: (question: string) => Promise<boolean> = async () => true, ask: { noConfirm?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "rovara-login-invite-"));
  dirs.push(home);
  const cell = options.cell ?? CELL;
  const events: string[] = [];
  const requests: Array<{ method: string; url: string; accept: string | null }> = [];
  const authorizeUrls: URL[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const url = urlOf(input);
    const method = init?.method ?? "GET";
    requests.push({ method, url, accept: new Headers(init?.headers).get("accept") });
    if (url === `${ROVARA_DIRECTORY_ORIGIN}/join/cell.json`) return Response.json(options.directory ?? { cellUrl: CELL });
    if (url === `${cell}/v1/auth/join?invite=${TOKEN}`) {
      const summary = options.summary ?? { status: 200, body: { orgName: "Acme", role: "member", state: "open" } };
      return Response.json(summary.body, { status: summary.status });
    }
    if (url === `${cell}/v1/auth/.well-known/agentx-configuration`) return Response.json({ ...configuration, issuer: `${cell}/v1/auth`, authorizationEndpoint: `${cell}/v1/auth/authorize`, tokenEndpoint: `${cell}/v1/auth/token`, revocationEndpoint: `${cell}/v1/auth/revoke` });
    if (url === `${cell}/v1/auth/token`) return Response.json({ access_token: "access.jwt.value", token_type: "Bearer", expires_in: 3600, refresh_token: REFRESH });
    if (url === `${cell}/v1/dev/org`) {
      if (options.org === "fails") return new Response("no", { status: 500 });
      return Response.json({ org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: (options.org ?? { name: "Acme" }).name, plan: "trial" }, role: (options.org ?? { role: "member" }).role ?? "member" });
    }
    if (url === `${cell}/v1/dev/projects`) return Response.json({ developer: { id: "a".repeat(64), name: "Bea Ortiz", provider: "cloud" }, projects: [], notices: [] });
    if (url === `${cell}/v1/app/me`) return new Response("no", { status: 500 });
    throw new Error(`unexpected ${method} ${url}`);
  });
  const openBrowser = vi.fn(async (link: string) => {
    events.push("browser");
    const authorize = new URL(link);
    authorizeUrls.push(authorize);
    const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    for (const [key, value] of Object.entries({ code: "agxc_code", ...options.callback })) callback.searchParams.set(key, value);
    await fetch(callback);
  });
  const questions: string[] = [];
  const run = (argv: string[]) => executeCli(argv, {
    fetchImplementation, tokenStore: new InMemoryTokenStore(), environments: { home },
    stdout: { write: (text: string) => { events.push("out"); out.push(text); } }, stderr: { write: (text: string) => { events.push(`err:${text.trim()}`); err.push(text); } },
    ...(ask.noConfirm === true ? { stdin: Readable.from([]) } : { confirm: async (question: string) => { questions.push(question); events.push("question"); return confirm(question); } }),
    login: { openBrowser },
  });
  return { home, run, out, err, events, requests, authorizeUrls, questions, openBrowser, fetchImplementation };
}

const rovaraLink = `https://rovara.dev/join#invite=${TOKEN}`;

describe("agentx login --invite", () => {
  it("says what the invite is for, asks, and only then opens the browser with the invite on the authorize URL", async () => {
    const w = await world({ org: { name: "Acme", role: "member" } });
    expect(await w.run(["login", "--invite", rovaraLink])).toBe(0);
    const shown = "This invite is for Acme (as member) on abc.execute-api.us-west-2.amazonaws.com.";
    expect(w.err.join("")).toContain(`${shown}\n`);
    expect(w.questions).toEqual(["Open the browser to join? (Y/n)"]);
    expect(w.events.indexOf(`err:${shown}`)).toBeGreaterThanOrEqual(0);
    expect(w.events.indexOf(`err:${shown}`)).toBeLessThan(w.events.indexOf("question"));
    expect(w.events.indexOf("question")).toBeLessThan(w.events.indexOf("browser"));
    expect(w.authorizeUrls).toHaveLength(1);
    expect(w.authorizeUrls[0]!.origin + w.authorizeUrls[0]!.pathname).toBe(`${ISSUER}/authorize`);
    expect(w.authorizeUrls[0]!.searchParams.get("invite")).toBe(TOKEN);
    expect(w.out.join("")).toContain("You joined Acme as member.\n");
    // The directory named the cell, and the cell was asked for JSON.
    expect(w.requests.find((request) => request.url === `${CELL}/v1/auth/join?invite=${TOKEN}`)?.accept).toBe("application/json");
    expect(w.requests.some((request) => request.url === "https://rovara.dev/join/cell.json")).toBe(true);
  });

  it("opens nothing, and signs nothing in, when the person declines", async () => {
    const w = await world({}, async () => false);
    expect(await w.run(["login", "--invite", rovaraLink])).not.toBe(0);
    expect(w.openBrowser).not.toHaveBeenCalled();
    expect(w.requests.some((request) => request.url.includes("/authorize") || request.url.endsWith("/token") || request.url.includes("agentx-configuration"))).toBe(false);
    expect(w.err.join("")).toContain("nothing changed");
  });

  it("--yes skips the question but still shows the line", async () => {
    const w = await world();
    expect(await w.run(["login", "--invite", rovaraLink, "--yes"])).toBe(0);
    expect(w.questions).toEqual([]);
    expect(w.err.join("")).toContain("This invite is for Acme (as member) on abc.execute-api.us-west-2.amazonaws.com.");
    expect(w.openBrowser).toHaveBeenCalledTimes(1);
  });

  it("works from a cell's own link without asking the directory", async () => {
    const w = await world();
    expect(await w.run(["login", "--invite", `${CELL}/v1/auth/join?invite=${TOKEN}`])).toBe(0);
    expect(w.requests.some((request) => request.url.startsWith("https://rovara.dev"))).toBe(false);
    expect(w.authorizeUrls[0]!.searchParams.get("invite")).toBe(TOKEN);
  });

  // UX1 review I1: a cell's own <origin>/join link works when the person names that cell (or has signed in to it before), and is refused otherwise.
  it("follows a cell's own /join link only to a cell it was given", async () => {
    const w = await world();
    expect(await w.run(["login", CELL, "--invite", `${CELL}/join#invite=${TOKEN}`, "--yes"])).toBe(0);
    expect(w.authorizeUrls[0]!.searchParams.get("invite")).toBe(TOKEN);
    const stranger = await world();
    expect(await stranger.run(["login", "--invite", `${CELL}/join#invite=${TOKEN}`])).not.toBe(0);
    expect(stranger.err.join("")).toContain("that is not a Rovara invite link");
    expect(stranger.requests).toEqual([]);
  });

  it("an explicit URL wins over the link's cell, and a bare token needs one", async () => {
    const other = "https://zzz.execute-api.eu-west-1.amazonaws.com";
    const w = await world({ cell: other });
    expect(await w.run(["login", other, "--invite", rovaraLink, "--yes"])).toBe(0);
    expect(w.requests.some((request) => request.url.startsWith("https://rovara.dev"))).toBe(false);
    expect(w.authorizeUrls[0]!.origin).toBe(other);
    const bare = await world();
    expect(await bare.run(["login", "--invite", TOKEN])).not.toBe(0);
    expect(bare.err.join("")).toContain("[CONFIG_INVALID]: that invite is only a code");
    expect(bare.openBrowser).not.toHaveBeenCalled();
    const withUrl = await world();
    expect(await withUrl.run(["login", CELL, "--invite", TOKEN, "--yes"])).toBe(0);
    expect(withUrl.authorizeUrls[0]!.searchParams.get("invite")).toBe(TOKEN);
  });

  it("refuses a link that is not a Rovara invite before reaching anyone", async () => {
    const w = await world();
    expect(await w.run(["login", "--invite", `https://evil.example/join#invite=${TOKEN}`])).not.toBe(0);
    expect(w.err.join("")).toContain("[CONFIG_INVALID]: that is not a Rovara invite link");
    expect(w.requests).toEqual([]);
  });

  it("will not mix --invite with --admin", async () => {
    const w = await world();
    expect(await w.run(["login", "--admin", "--invite", rovaraLink])).not.toBe(0);
    expect(w.requests).toEqual([]);
  });

  it.each([["used", 410], ["expired", 410]])("stops before the browser for an invite that is %s", async (state, status) => {
    const w = await world({ summary: { status, body: { state } } });
    expect(await w.run(["login", "--invite", rovaraLink])).not.toBe(0);
    expect(w.err.join("")).toContain("That invite can no longer be used; ask for a new one.");
    expect(w.openBrowser).not.toHaveBeenCalled();
    expect(w.questions).toEqual([]);
  });

  it("stops before the browser for an unknown invite", async () => {
    const w = await world({ summary: { status: 404, body: { state: "unknown" } } });
    expect(await w.run(["login", "--invite", rovaraLink])).not.toBe(0);
    expect(w.err.join("")).toContain("that invite link isn't valid");
    expect(w.openBrowser).not.toHaveBeenCalled();
  });

  it("does not trust a server that answers something else", async () => {
    const w = await world({ summary: { status: 200, body: { hello: "world" } } });
    expect(await w.run(["login", "--invite", rovaraLink])).not.toBe(0);
    expect(w.err.join("")).toContain("did not answer as a Rovara sign-in server");
    expect(w.openBrowser).not.toHaveBeenCalled();
  });

  it("strips terminal escapes from the organization name before showing it", async () => {
    const w = await world({ summary: { status: 200, body: { orgName: "Ac\u001b[2Jme", role: "admin", state: "open" } } });
    expect(await w.run(["login", "--invite", rovaraLink, "--yes"])).toBe(0);
    expect(w.err.join("")).toContain("This invite is for Ac[2Jme (as admin) on");
  });

  const outcomes: Array<[string, string]> = [
    ["ALREADY_IN_ORG", "You're already in Bea's team. For now, a person can belong to one Rovara organization: sign in with a different email address, or ask an owner of Bea's team to remove you. If Bea's team is a team you made by mistake and no one else is in it, run agentx org leave and try the invite again."],
    ["INVITE_WRONG_EMAIL", INVITE_WRONG_EMAIL_MESSAGE],
    ["INVITE_INVALID", "That invite can no longer be used; ask for a new one."],
  ];

  it.each(outcomes)("%s: prints the exact line once, exits 1, and keeps the session that was issued", async (inviteError, line) => {
    const w = await world({ callback: { inviteError }, org: { name: "Bea's team", role: "owner" } });
    expect(await w.run(["login", "--invite", rovaraLink, "--yes"])).toBe(1);
    expect(w.err.join("").split(line)).toHaveLength(2);
    expect(w.err.join("")).toContain(`AgentX error [${inviteError}]: ${line}\n`);
    expect(w.out.join("")).not.toContain("You joined");
    expect(w.out.join("")).toBe("");
    // The sign-in itself worked: its token was exchanged and the environment saved.
    expect(w.requests.some((request) => request.url === `${ISSUER}/token`)).toBe(true);
    expect(await readDeveloperConfig(w.home)).toMatchObject({ environments: { staging: { url: CELL } } });
  });

  it.each(outcomes)("%s: --json reports ok: false with the code and the line", async (inviteError, line) => {
    const w = await world({ callback: { inviteError }, org: { name: "Bea's team", role: "owner" } });
    expect(await w.run(["--json", "login", "--invite", rovaraLink, "--yes"])).toBe(1);
    expect(JSON.parse(w.err.join("").trim().split("\n").at(-1) ?? "")).toEqual({ ok: false, error: { code: inviteError, message: line } });
    expect(w.out.join("")).toBe("");
  });

  it("ALREADY_IN_ORG names no organization when the current one cannot be read", async () => {
    const w = await world({ callback: { inviteError: "ALREADY_IN_ORG" }, org: "fails" });
    expect(await w.run(["login", "--invite", rovaraLink, "--yes"])).toBe(1);
    expect(w.err.join("")).toContain("You're already in another Rovara organization.");
  });

  it("asks for a terminal, and opens nothing, when there is none and no --yes", async () => {
    const w = await world({}, undefined, { noConfirm: true });
    expect(await w.run(["login", "--invite", rovaraLink])).not.toBe(0);
    expect(w.err.join("")).toContain("[CONFIRMATION_UNAVAILABLE]");
    expect(w.openBrowser).not.toHaveBeenCalled();
    expect(w.requests.some((request) => request.url.endsWith("/token") || request.url.includes("agentx-configuration"))).toBe(false);
    expect(await w.run(["login", "--invite", rovaraLink, "--yes"])).toBe(0);
  });

  it("with --no-browser the question does not promise a browser", async () => {
    const w = await world({}, async () => false);
    expect(await w.run(["login", "--invite", rovaraLink, "--no-browser"])).not.toBe(0);
    expect(w.questions).toEqual(["Continue to join? (Y/n)"]);
  });

  it("ignores an inviteError it does not know", async () => {
    const w = await world({ callback: { inviteError: "SOMETHING_ELSE" } });
    expect(await w.run(["login", "--invite", rovaraLink, "--yes"])).toBe(0);
    expect(w.out.join("")).toContain("You joined Acme as member.");
  });

  it("still says it joined when the organization cannot be read afterwards", async () => {
    const w = await world({ org: "fails" });
    expect(await w.run(["login", "--invite", rovaraLink, "--yes"])).toBe(0);
    expect(w.out.join("")).toContain("You joined the organization.\n");
  });

  it("--json carries the outcome and its words", async () => {
    const w = await world({ org: { name: "Acme", role: "member" } });
    expect(await w.run(["--json", "login", "--invite", rovaraLink, "--yes"])).toBe(0);
    expect(JSON.parse(w.out.join(""))).toMatchObject({ ok: true, data: { invite: { outcome: "joined", message: "You joined Acme as member." } } });
  });
});

describe("developerLogin with an invite", () => {
  it("carries invite=<token> on the authorize URL, and reports an inviteError", async () => {
    const home = await mkdtemp(join(tmpdir(), "rovara-login-invite-"));
    dirs.push(home);
    let authorize: URL | undefined;
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = urlOf(input);
      if (url.endsWith("/agentx-configuration")) return Response.json(configuration);
      if (url === `${ISSUER}/token`) return Response.json({ access_token: "access.jwt.value", token_type: "Bearer", expires_in: 3600, refresh_token: REFRESH });
      throw new Error(`unexpected ${url}`);
    });
    const result = await developerLogin({
      url: CELL, allowLoopback: false, browser: true, home, tokenStore: new InMemoryTokenStore(), fetch: fetchImplementation, write: () => undefined, invite: TOKEN,
      openBrowser: async (link) => {
        authorize = new URL(link);
        const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
        callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
        callback.searchParams.set("code", "agxc_code");
        callback.searchParams.set("inviteError", "INVITE_WRONG_EMAIL");
        await fetch(callback);
      },
    });
    expect(authorize?.searchParams.get("invite")).toBe(TOKEN);
    expect(result.inviteError).toBe("INVITE_WRONG_EMAIL");
  });

  it("sends no invite parameter without one", async () => {
    const home = await mkdtemp(join(tmpdir(), "rovara-login-invite-"));
    dirs.push(home);
    let authorize: URL | undefined;
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = urlOf(input);
      if (url.endsWith("/agentx-configuration")) return Response.json(configuration);
      return Response.json({ access_token: "access.jwt.value", token_type: "Bearer", expires_in: 3600, refresh_token: REFRESH });
    });
    const result = await developerLogin({
      url: CELL, allowLoopback: false, browser: true, home, tokenStore: new InMemoryTokenStore(), fetch: fetchImplementation, write: () => undefined,
      openBrowser: async (link) => {
        authorize = new URL(link);
        const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
        callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
        callback.searchParams.set("code", "agxc_code");
        await fetch(callback);
      },
    });
    expect(authorize?.searchParams.has("invite")).toBe(false);
    expect(result.inviteError).toBeUndefined();
  });
});
