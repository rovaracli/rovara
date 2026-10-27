// C55 (staging 0.4.11): a pull request Rovara wrote said "Requested by <the requester's email>". Whatever Rovara writes on GitHub names a person by their display name, or by
// their linked GitHub login when the display name is an address; never an email address. The sign-in provider falls back to the address as the display name when it has no
// name for a person, so the stored name itself can be an email.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { attributionOf } from "../../packages/broker/src/agents/agent-tools-routes.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { developerFooter, developerTaskIdentity, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { githubLoginOf, personNameForText, withoutEmails } from "../../packages/broker/src/developer/requester-text.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { markReady } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";

const GITHUB_ISSUER = "https://github.com";
const ANY_EMAIL = /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/u;

describe("withoutEmails and personNameForText", () => {
  it("removes addresses wherever they sit and leaves a name alone", () => {
    expect(withoutEmails("maya.chen+rovara@acme.example")).toBe("");
    expect(withoutEmails("Maya Chen <maya@acme.example>")).toBe("Maya Chen");
    expect(withoutEmails("Maya (maya@acme.example) Chen")).toBe("Maya Chen");
    expect(withoutEmails("Maya Chen")).toBe("Maya Chen");
    expect(withoutEmails("@octocat")).toBe("@octocat");
  });

  it("uses the display name, else the linked GitHub login, else nothing", () => {
    expect(personNameForText("Maya Chen", "maya-gh")).toBe("Maya Chen");
    expect(personNameForText("maya@acme.example", "maya-gh")).toBe("maya-gh");
    expect(personNameForText("maya@acme.example", undefined)).toBeUndefined();
    // A login GitHub could not have issued is not used.
    expect(personNameForText("maya@acme.example", "not a login <script>")).toBeUndefined();
  });
});

describe("the footers Rovara writes", () => {
  it("never carry an email: an address as the display name reads as the task owner, or as the GitHub login", () => {
    expect(developerFooter("maya@acme.example", "Claude Code")).toBe("Requested by the task owner via AgentX, started from Claude Code");
    expect(developerFooter("maya@acme.example", "Claude Code", "Rovara", "maya-gh")).toBe("Requested by `maya-gh` via Rovara, started from Claude Code");
    expect(developerFooter("Maya Chen <maya@acme.example>", "Claude Code")).toBe("Requested by `Maya Chen` via AgentX, started from Claude Code");
    expect(developerFooter("Maya Chen", "Claude Code", "Rovara", "maya-gh")).toBe("Requested by `Maya Chen` via Rovara, started from Claude Code");
  });

  it("the connector footer of an agent's write names the owner without an address", () => {
    const task = (name: string) => ({ pk: "DEVTASK#t", sk: "META", entityType: "DEVELOPER_TASK", taskId: randomUUID(), developerId: MAYA.developerId, developerName: name, provider: "oidc" }) as unknown as DeveloperTaskRecord;
    expect(attributionOf(task("maya@acme.example"), "Triage")).toBe("Requested by `a member` via Rovara agent `Triage`");
    expect(attributionOf(task("maya@acme.example"), "Triage", "maya-gh")).toBe("Requested by `maya-gh` via Rovara agent `Triage`");
    expect(attributionOf(task("Maya Chen"), "Triage")).toBe("Requested by `Maya Chen` via Rovara agent `Triage`");
  });
});

describe("the pull request body the broker stores (acceptPullRequest)", () => {
  const taskId = "55555555-5555-4555-8555-555555555555";
  async function bodyFor(developerName: string, link?: { login?: string }) {
    const harness = await createDeveloperTaskBroker();
    const identity = developerTaskIdentity({ taskId, developerId: MAYA.developerId, provider: "oidc", developerName, client: "Claude Code" }, TEST_ORG);
    const project = await harness.actions.latestProject(TEST_ORG, "payments");
    const preparation = await harness.actions.preparation(identity, project!, randomUUID());
    await harness.actions.transact(preparation.items);
    markReady(harness.db, preparation.workspace.id);
    if (link !== undefined) {
      const store = new DeveloperSignInStore({ documentClient: harness.db, tableName: "signin", now: Date.now });
      await store.linkIdentity({ identityKey: "k".repeat(64), developerId: MAYA.developerId, provider: "github", issuer: GITHUB_ISSUER, subject: "4711", email: "maya@acme.example", ...(link.login === undefined ? {} : { login: link.login }) });
    }
    const accepted = await harness.actions.acceptPullRequest(identity, preparation.workspace.id, { requestId: randomUUID(), repository: "demo", title: "Fix", body: "Fixes #12." }, () => []);
    return (harness.db.get(`WORKSPACE#${preparation.workspace.id}`, `OPERATION#${accepted.operation.id}`) as { publication: { body: string } }).publication.body;
  }

  it("says the task owner when the display name is an address and no GitHub account is linked", async () => {
    const body = await bodyFor("maya@acme.example");
    expect(body).toBe("Fixes #12.\n\n---\nRequested by the task owner via AgentX, started from Claude Code");
    expect(body).not.toMatch(ANY_EMAIL);
  });

  it("says the linked GitHub login when the display name is an address", async () => {
    const body = await bodyFor("maya@acme.example", { login: "maya-gh" });
    expect(body).toBe("Fixes #12.\n\n---\nRequested by `maya-gh` via AgentX, started from Claude Code");
    expect(body).not.toMatch(ANY_EMAIL);
  });

  it("keeps a real display name, even when a GitHub account is linked", async () => {
    expect(await bodyFor("Maya Chen", { login: "maya-gh" })).toBe("Fixes #12.\n\n---\nRequested by `Maya Chen` via AgentX, started from Claude Code");
  });

  it("githubLoginOf reads the login of the linked GitHub account, and nothing for a person with none", async () => {
    const harness = await createDeveloperTaskBroker();
    const store = new DeveloperSignInStore({ documentClient: harness.db, tableName: "signin", now: Date.now });
    expect(await githubLoginOf(store, MAYA.developerId)).toBeUndefined();
    await store.linkIdentity({ identityKey: "j".repeat(64), developerId: MAYA.developerId, provider: "github", issuer: GITHUB_ISSUER, subject: "4711", login: "maya-gh" });
    expect(await githubLoginOf(store, MAYA.developerId)).toBe("maya-gh");
  });
});
