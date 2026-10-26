// Bug E (staging 0.4.11): every answer on /v1/app and /v1/web leaves the broker's `json()` with the gateway's `requestId` beside its own fields, and the CLI read three Plan 6 answers
// with strict schemas that had no room for it, so `agentx project code-settings` failed against the live control plane with "AgentX answered with something unexpected". The CLI's own
// tests answered with hand-made objects, which never carried `requestId`. These tests run the real CLI against the real broker handler (the real routes and the real `json()` wrapper),
// so a client schema that cannot read what the server really sends fails here.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { projectMemberKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { DEV_ISSUER, MAYA, bearerFor, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";

// The broker builds confirmation links on its own origin (the harness issuer's), and the CLI prints a link only when it is on the control plane it asked.
const URL_ = DEV_ISSUER.replace(/\/v1\/auth$/, "");
const ISSUER = `${URL_}/v1/auth`;
const entry = { url: URL_, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
beforeAll(loadSlackBroker);

type Broker = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;

/** The real CLI, signed in as Maya, whose every request goes to the real broker handler and whose answers are the handler's own bytes. */
async function cliAgainst(h: Broker, options: { onAnswer?: (call: { method: string; path: string; status: number; body: Record<string, unknown> }) => void } = {}) {
  const home = await mkdtemp(join(tmpdir(), "rovara-bug-e-"));
  dirs.push(home);
  await saveDeveloperEnvironment(home, "staging", entry);
  const tokenStore = new InMemoryTokenStore();
  await tokenStore.set(developerTokenKey(ISSUER), { accessToken: (await bearerFor(MAYA, await h.orgOf(MAYA))).replace(/^Bearer /, ""), refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
  const out: string[] = [];
  const err: string[] = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const response = await h.handler({
      version: "2.0", rawPath: target.pathname, rawQueryString: target.search.slice(1), headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(typeof init?.body === "string" ? { body: init.body } : {}), requestContext: { requestId: randomUUID(), http: { method } },
    });
    options.onAnswer?.({ method, path: target.pathname, status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> });
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  };
  const run = (argv: string[]) => executeCli(argv, {
    fetchImplementation, tokenStore, environments: { home }, stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) },
  });
  return { run, text: () => out.join(""), errors: () => err.join("") };
}

/** Maya as a maintainer of `payments` (the code-settings PUT needs `edit_settings`). */
function maintainer(h: Broker): void {
  h.db.set({ ...projectMemberKey(TEST_ORG, MAYA.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: MAYA.developerId, projectName: "payments", grantId: randomUUID(), role: "developer", projectRole: "maintainer", grantedAt: new Date().toISOString() });
}

describe("agentx project code-settings against the real broker", () => {
  it("reads the settings the broker answers, which carry the gateway's requestId", async () => {
    const h = await createDeveloperTaskBroker();
    maintainer(h);
    const answers: Array<{ status: number; body: Record<string, unknown> }> = [];
    const cli = await cliAgainst(h, { onAnswer: (answer) => answers.push(answer) });
    expect(await cli.run(["project", "code-settings", "payments"]), cli.errors()).toBe(0);
    // The premise of the bug: the real answer is `{ settings, requestId }`.
    expect(answers[0]!.status).toBe(200);
    expect(Object.keys(answers[0]!.body).sort()).toEqual(["requestId", "settings"]);
    expect(cli.text()).toBe(["Code settings for payments (revision 0):", "  Self-approval: off", "  Merge method: squash", "  Reviewers: none", ""].join("\n"));
  });

  it("changes the merge method and reviewers under the revision it read", async () => {
    const h = await createDeveloperTaskBroker();
    maintainer(h);
    const cli = await cliAgainst(h);
    expect(await cli.run(["project", "code-settings", "payments", "--merge-method", "merge", "--reviewers", "alice,acme/core"]), cli.errors()).toBe(0);
    expect(cli.text()).toBe(["Changed the code settings of payments.", "  Self-approval: off", "  Merge method: merge", "  Reviewers: alice, acme/core", ""].join("\n"));
    expect(await cli.run(["project", "code-settings", "payments"]), cli.errors()).toBe(0);
    expect(cli.text()).toContain("(revision 1)");
  });

  it("prints the link where an organization owner or admin confirms self-approval, from the broker's 202", async () => {
    const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
    maintainer(h);
    const answers: Array<{ status: number; body: Record<string, unknown> }> = [];
    const cli = await cliAgainst(h, { onAnswer: (answer) => answers.push(answer) });
    expect(await cli.run(["project", "code-settings", "payments", "--self-approval", "on"]), cli.errors()).toBe(0);
    const put = answers.at(-1)!;
    expect(put.status).toBe(202);
    expect(Object.keys(put.body).sort()).toEqual(["changes", "code", "confirmUrl", "requestId", "status"]);
    expect(cli.text()).toContain("An organization owner or admin has to confirm turning self-approval on. Nothing has changed for it yet.");
    expect(cli.text()).toContain(`Confirm this in your browser: ${String(put.body.confirmUrl)}`);
  });
});
