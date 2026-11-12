// Lane A9: Cloud's Jira tracker (`packages/broker/src/plugins/tracker/jira`) under Code's Tracker suite. The company's Jira connection is real Cloud code over an in-memory State table and
// in-memory company secrets (no AWS); Jira itself is a small in-memory REST site that answers the calls the adapter and the ticket-updates writer make, in Jira Cloud's documented shapes.
import type { NeutralStatus, OrgId } from "@rovara-code/contracts";
import { OrgSecrets } from "../../../packages/broker/src/connections/org-secrets.js";
import { OrgConnectionStore, type OrgConnectionDeps } from "../../../packages/broker/src/connections/store.js";
import { cloudJiraTracker } from "../../../packages/broker/src/plugins/tracker/jira/index.js";
import type { TrackerWorld } from "../../../vendor/rovara-code/tests/support/ports/tracker-conformance.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { FAKE_CONNECTOR_ROLE_ARN, FakeOrgSecrets } from "../../support/fake-org-secrets.js";
import { defineCloudAdapter } from "../registry.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const NOW = Date.parse("2026-11-11T10:00:00.000Z");
export const JIRA_SITE = "https://acme.atlassian.net";
const ROVARA_ACCOUNT = "acct-rovara";
/** Jira's status category of each neutral status, and the status names the site's workflow has. */
const CATEGORY_OF: Record<NeutralStatus, string> = { open: "new", in_progress: "indeterminate", in_review: "indeterminate", done: "done", cancelled: "done" };
const NAME_OF: Record<NeutralStatus, string> = { open: "To Do", in_progress: "In Progress", in_review: "In Review", done: "Done", cancelled: "Won't Do" };

interface JiraIssue { key: string; summary: string; description: string; status: NeutralStatus; labels: string[]; assignee?: string | undefined; comments: Array<{ author: string; text: string; properties: unknown[] }> }

/** A Jira Cloud site in memory: issues, their comments (with properties) and transitions to every status of the workflow. Requests with any other path are 404. */
export class InMemoryJiraSite {
  readonly issues = new Map<string, JiraIssue>();
  readonly requests: Array<{ method: string; url: string }> = [];

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    this.requests.push({ method, url: url.href });
    if (url.origin !== JIRA_SITE || init?.redirect !== "error") return new Response("{}", { status: 400 });
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (url.pathname === "/rest/api/3/myself") return Response.json({ accountId: ROVARA_ACCOUNT });
    const match = /^\/rest\/api\/3\/issue\/([^/]+)(\/comment|\/transitions)?$/u.exec(url.pathname);
    const issue = match === null ? undefined : this.issues.get(decodeURIComponent(match[1]!));
    if (match === null || issue === undefined) return Response.json({ errorMessages: ["Issue does not exist"] }, { status: 404 });
    if (match[2] === undefined && method === "GET") {
      return Response.json({
        key: issue.key, fields: {
          summary: issue.summary, description: { type: "doc", version: 1, content: issue.description.split("\n").map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] })) },
          status: { name: NAME_OF[issue.status], statusCategory: { key: CATEGORY_OF[issue.status] } }, labels: issue.labels,
          assignee: issue.assignee === undefined ? null : { displayName: issue.assignee }, updated: "2026-11-11T09:00:00.000+0000",
        },
      });
    }
    if (match[2] === "/comment" && method === "GET") return Response.json({ comments: issue.comments.map((comment, index) => ({ id: String(index + 1), author: { accountId: comment.author }, properties: comment.properties })) });
    if (match[2] === "/comment" && method === "POST") {
      const content = (rec(body["body"])["content"] ?? []) as Array<{ content: Array<{ text: string }> }>;
      issue.comments.push({ author: ROVARA_ACCOUNT, text: content.map((paragraph) => paragraph.content.map((node) => node.text).join("")).join("\n"), properties: (body["properties"] ?? []) as unknown[] });
      return Response.json({ id: String(issue.comments.length) }, { status: 201 });
    }
    if (match[2] === "/transitions" && method === "GET") {
      return Response.json({ transitions: (Object.keys(NAME_OF) as NeutralStatus[]).map((status) => ({ id: `t-${status}`, name: NAME_OF[status], to: { name: NAME_OF[status] } })) });
    }
    if (match[2] === "/transitions" && method === "POST") {
      const transitionId = rec(body["transition"])["id"];
      const id = typeof transitionId === "string" ? transitionId : "";
      const status = (Object.keys(NAME_OF) as NeutralStatus[]).find((entry) => `t-${entry}` === id);
      if (status === undefined) return Response.json({}, { status: 400 });
      issue.status = status;
      return new Response(null, { status: 204 });
    }
    return Response.json({}, { status: 405 });
  }) as typeof fetch;
}

const rec = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

/** The company's connection store over in-memory DynamoDB and secrets, holding one Jira connection to the site. */
export async function jiraConnections(access: "read" | "read_write" = "read_write", identity: "service" | "personal" = "service"): Promise<OrgConnectionDeps> {
  const fake = new FakeOrgSecrets({ env: "staging", now: () => NOW });
  const secrets = new OrgSecrets({ env: "staging", roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: () => NOW });
  const deps: OrgConnectionDeps = { documentClient: new FakeDynamoDb(), tableName: "T", env: "staging", secrets, now: () => NOW };
  await new OrgConnectionStore(deps).put({
    orgId: ORG, by: "dev-admin",
    connection: { connectionId: "con_jira0000000000000001", type: "jira", label: "Jira", access, siteUrl: JIRA_SITE, identity },
    // A token made at run time: never a real-looking key in a fixture.
    secret: { email: "rovara@acme.test", apiToken: ["not", "a", "real", "token"].join("-") },
  });
  return deps;
}

export async function jiraWorld(): Promise<TrackerWorld & { site: InMemoryJiraSite }> {
  const site = new InMemoryJiraSite();
  const tracker = cloudJiraTracker({ connections: await jiraConnections(), fetch: site.fetch, installOrg: () => ORG });
  return {
    tracker, site, scope: { orgId: ORG },
    addItem: (id, input) => {
      site.issues.set(id, { key: id, summary: input?.title ?? `Issue ${id}`, description: input?.body ?? "", status: input?.status ?? "open", labels: input?.labels ?? [], assignee: input?.assignee, comments: [] });
    },
    statusOf: (id) => site.issues.get(id)?.status,
    commentsOf: (id) => site.issues.get(id)?.comments.map((comment) => comment.text) ?? [],
  };
}

export const jiraTrackerAdapter = defineCloudAdapter({
  port: "tracker",
  name: "Jira",
  harness: { makeWorld: jiraWorld },
});
