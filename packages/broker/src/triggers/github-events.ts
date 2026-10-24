// Plan 4 Task 21: GitHub's events as triggers' events. They arrive through the one webhook the GitHub App already has, which has verified the signature over the bytes (`github-webhooks.ts`;
// there is no second verifier). From here the body is trusted only as far as that signature goes, and no further than the org's own records:
//   1. the installation the body names must be bound to an org and active (`GITHUB_INSTALLATION#`); its org is the only org an event can start work in;
//   2. the projects are the ones the repository's index (`GITHUB_REPO#<id>`) lists for that org, and each is believed only if its LATEST revision pins this installation and this
//      repository (a stale or foreign index row is logged and ignored);
//   3. each event is made of the body's own fields, with the project from the record and no hook (GitHub's events have none);
//   4. a replay (the same body under a new delivery id) is the same event key, remembered per project for a day;
//   5. dispatch (Task 20) decides everything else, including what Rovara's own bot did (the loop guard).
// Only ids, codes and counts are logged: never a title, a branch, a label or a body.
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { OrgIdSchema, RUN_START_TITLE_MAX, TriggerEventSchema, githubInstallationKey, githubRepoProjectKey, type OrgId, type TriggerEvent } from "@agentx/contracts";
import { GithubWebhookRetryableError } from "../aws/github-webhooks.js";
import { latestRevision } from "../org/project-settings.js";
import { firstSight, forget, markDispatched, outsideEventWindow, type EventMemoryDeps } from "./ingress.js";

export interface GithubTriggerDependencies extends EventMemoryDeps {
  now: () => number;
  /** The GitHub App's slug, to tell its own bot (`<slug>[bot]`) from a person. Without it every bot is taken for Rovara's. */
  githubAppSlug?: () => Promise<string | undefined>;
  /** Task 20's `dispatchTriggerEvent`, over the broker's dependencies. */
  dispatch(orgId: OrgId, event: TriggerEvent): Promise<unknown>;
}

export interface GithubTriggerInput {
  eventName: string;
  payload: unknown;
  installationId: number;
}

/** The hook segment GitHub's events are remembered under. */
const GITHUB_HOOK = "github";
const MAX_FIELD_VALUES = 50;
const MAX_FIELD_CHARS = 200;

const Account = z.object({ login: z.string().min(1).max(200), type: z.string().max(40).optional() }).passthrough();
const Labels = z.array(z.object({ name: z.string() }).passthrough()).optional();
const Time = z.string().min(1).max(64);
const Common = z.object({
  action: z.string().max(64).optional(),
  repository: z.object({ id: z.number().int().positive(), html_url: z.string().max(2048).optional() }).passthrough(),
  sender: Account.optional(),
}).passthrough();

const PullRequestBody = Common.extend({
  action: z.string().max(64),
  pull_request: z.object({
    number: z.number().int().positive(), title: z.string().max(10_000).optional(), html_url: z.string().max(2048).optional(), updated_at: Time,
    author_association: z.string().max(40).optional(), labels: Labels, base: z.object({ ref: z.string().max(500).optional() }).passthrough().optional(),
  }).passthrough(),
});
const IssueBody = Common.extend({
  action: z.string().max(64),
  issue: z.object({
    number: z.number().int().positive(), title: z.string().max(10_000).optional(), html_url: z.string().max(2048).optional(), created_at: Time.optional(), updated_at: Time.optional(),
    author_association: z.string().max(40).optional(), labels: Labels, pull_request: z.unknown().optional(),
  }).passthrough(),
});
const DeploymentStatusBody = Common.extend({
  deployment_status: z.object({ id: z.number().int().positive(), state: z.string().max(40), environment: z.string().max(500).optional(), created_at: Time }).passthrough(),
  deployment: z.object({ environment: z.string().max(500).optional(), creator: Account.optional() }).passthrough().optional(),
});
const WorkflowRunBody = Common.extend({
  action: z.string().max(64),
  workflow_run: z.object({
    id: z.number().int().positive(), run_attempt: z.number().int().positive().optional(), name: z.string().max(500).optional(), conclusion: z.string().max(40).nullable().optional(),
    head_branch: z.string().max(500).nullable().optional(), updated_at: Time, html_url: z.string().max(2048).optional(), actor: Account.optional(), triggering_actor: Account.optional(),
  }).passthrough(),
});

const log = (deps: Pick<EventMemoryDeps, "log">) => deps.log ?? ((event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", event, ...fields })));

/** A person's words made fit for a title: no control or invisible characters, cut to what an event may carry. */
const titleOf = (text: string | undefined, fallback: string): string => {
  const clean = [...(text ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").trim()].slice(0, RUN_START_TITLE_MAX).join("");
  return clean === "" ? fallback : clean;
};

/** A link GitHub gave, only when it is a plain https link on github.com: a deployment's target or an environment's link can be anywhere. */
const githubUrl = (link: string | undefined): string | undefined => {
  if (link === undefined) return undefined;
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.hostname === "github.com" && url.username === "" && url.password === "" ? url.href : undefined;
  } catch {
    return undefined;
  }
};

/** The `url` member of a subject: the link when it is one, nothing otherwise. */
const urlOf = (link: string | undefined): { url?: string } => {
  const url = githubUrl(link);
  return url === undefined ? {} : { url };
};

const valuesOf = (values: ReadonlyArray<string | null | undefined>): string[] => values.filter((value): value is string => typeof value === "string" && value !== "").map((value) => value.slice(0, MAX_FIELD_CHARS)).slice(0, MAX_FIELD_VALUES);
const isoOf = (time: string | undefined): string | undefined => {
  const at = time === undefined ? Number.NaN : Date.parse(time);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
};

/** What an event is, before the project and the actor are known. */
interface Mapped {
  type: string;
  eventKey: string;
  occurredAt: string;
  subject: TriggerEvent["subject"];
  fields: Record<string, string[]>;
  /** Everyone the event involves: the sender first. A bot among them is Rovara's if it is the App's. */
  involved: Array<z.infer<typeof Account>>;
}

function mapEvent(eventName: string, payload: unknown, repositoryUrl: string | undefined): Mapped | undefined {
  if (eventName === "pull_request") {
    const parsed = PullRequestBody.safeParse(payload);
    if (!parsed.success || (parsed.data.action !== "opened" && parsed.data.action !== "ready_for_review")) return undefined;
    const { pull_request: pr, repository, action, sender } = parsed.data;
    const occurredAt = isoOf(pr.updated_at);
    if (occurredAt === undefined) return undefined;
    return {
      type: `pull_request.${action}`, eventKey: `gh:pr:${String(repository.id)}:${String(pr.number)}:${action}:${pr.updated_at}`, occurredAt,
      subject: { kind: "pull_request", id: String(pr.number), title: titleOf(pr.title, `Pull request ${String(pr.number)}`), ...urlOf(pr.html_url) },
      fields: { baseBranch: valuesOf([pr.base?.ref]), label: valuesOf((pr.labels ?? []).map((label) => label.name)), authorAssociation: valuesOf([pr.author_association]) },
      involved: sender === undefined ? [] : [sender],
    };
  }
  if (eventName === "issues") {
    const parsed = IssueBody.safeParse(payload);
    // An issue that is a pull request is the pull request's event (GitHub sends a pull request's own).
    if (!parsed.success || parsed.data.action !== "opened" || parsed.data.issue.pull_request !== undefined) return undefined;
    const { issue, repository, sender } = parsed.data;
    const occurredAt = isoOf(issue.updated_at ?? issue.created_at);
    if (occurredAt === undefined) return undefined;
    return {
      type: "issues.opened", eventKey: `gh:issue:${String(repository.id)}:${String(issue.number)}:opened`, occurredAt,
      subject: { kind: "issue", id: String(issue.number), title: titleOf(issue.title, `Issue ${String(issue.number)}`), ...urlOf(issue.html_url) },
      fields: { label: valuesOf((issue.labels ?? []).map((label) => label.name)), authorAssociation: valuesOf([issue.author_association]) },
      involved: sender === undefined ? [] : [sender],
    };
  }
  if (eventName === "deployment_status") {
    const parsed = DeploymentStatusBody.safeParse(payload);
    if (!parsed.success) return undefined;
    const { deployment_status: status, deployment, sender } = parsed.data;
    const type = status.state === "success" ? "deployment_status.success" : status.state === "failure" || status.state === "error" ? "deployment_status.failure" : undefined;
    const occurredAt = isoOf(status.created_at);
    if (type === undefined || occurredAt === undefined) return undefined;
    const environment = status.environment ?? deployment?.environment;
    return {
      type, eventKey: `gh:depstatus:${String(status.id)}`, occurredAt,
      // The status's own links (its target, its log) can be any site, so the link is the repository's deployments page.
      subject: { kind: "deployment", id: String(status.id), title: titleOf(`Deployment to ${environment ?? "an environment"}: ${status.state}`, "Deployment"), ...urlOf(repositoryUrl === undefined ? undefined : `${repositoryUrl}/deployments`) },
      fields: { environment: valuesOf([environment]) },
      involved: [...(sender === undefined ? [] : [sender]), ...(deployment?.creator === undefined ? [] : [deployment.creator])],
    };
  }
  if (eventName === "workflow_run") {
    const parsed = WorkflowRunBody.safeParse(payload);
    if (!parsed.success || parsed.data.action !== "completed") return undefined;
    const { workflow_run: run, sender } = parsed.data;
    const occurredAt = isoOf(run.updated_at);
    if (occurredAt === undefined) return undefined;
    return {
      type: "workflow_run.completed", eventKey: `gh:run:${String(run.id)}:${String(run.run_attempt ?? 1)}`, occurredAt,
      subject: { kind: "workflow_run", id: String(run.id), title: titleOf(`${run.name ?? "Workflow"}: ${run.conclusion ?? "completed"}`, "Workflow run"), ...urlOf(run.html_url) },
      fields: { workflow: valuesOf([run.name]), conclusion: valuesOf([run.conclusion]), branch: valuesOf([run.head_branch]) },
      involved: [...(sender === undefined ? [] : [sender]), ...(run.actor === undefined ? [] : [run.actor]), ...(run.triggering_actor === undefined ? [] : [run.triggering_actor])],
    };
  }
  return undefined;
}

/**
 * Who the event says it was: Rovara when any account it involves is a bot that is the App's (`<slug>[bot]`). Without the slug no bot can be told from Rovara's, so every bot is taken
 * for it: a loop is worse than a missed event from another bot. Dispatch checks the actor's id against Rovara's accounts again, whatever this says.
 */
async function actorOf(deps: Pick<GithubTriggerDependencies, "githubAppSlug">, involved: Mapped["involved"]): Promise<TriggerEvent["actor"]> {
  const slug = await deps.githubAppSlug?.();
  const own = involved.find((account) => account.type === "Bot" && (slug === undefined || slug === "" || account.login === `${slug}[bot]`));
  if (own !== undefined) return { kind: "rovara", id: own.login };
  const sender = involved[0];
  return sender === undefined ? { kind: "unknown" } : { kind: "external", id: sender.login };
}

/** The org the installation is bound to, when it is bound and active. */
async function orgOfInstallation(deps: Pick<EventMemoryDeps, "documentClient" | "tableName">, installationId: number): Promise<OrgId | undefined> {
  const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: githubInstallationKey(installationId), ConsistentRead: true })) as { Item?: { orgId?: unknown; status?: unknown } };
  const orgId = OrgIdSchema.safeParse(found.Item?.orgId);
  return orgId.success && found.Item?.status === "active" ? orgId.data : undefined;
}

/** The projects of `orgId` the repository's index lists and whose latest revision pins this installation and this repository; each other row is logged and left out. */
async function projectsOf(deps: Pick<EventMemoryDeps, "documentClient" | "tableName" | "log">, orgId: OrgId, installationId: number, repositoryId: number): Promise<string[]> {
  const rows: Array<Record<string, unknown>> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": `GITHUB_REPO#${String(repositoryId)}` }, ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    rows.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  const projects: string[] = [];
  for (const row of rows) {
    const named = typeof row["sk"] === "string" ? row["sk"] : "";
    const project = typeof row["project"] === "string" ? row["project"] : named.slice(named.indexOf("#") + 1);
    const rowOrg = typeof row["orgId"] === "string" ? row["orgId"] : named.slice(0, Math.max(named.indexOf("#"), 0));
    const stale = (): void => log(deps)("github.trigger_stale_index", { orgId: rowOrg, project, installationId, repositoryId });
    // The row must name this org (in its attribute and its key) and a project; anything else is a lead that no longer holds.
    if (rowOrg !== orgId || named !== `${orgId}#${project}` || project === "") {
      stale();
      continue;
    }
    const revision = await latestRevision(deps, orgId, project);
    if (revision?.definition.repositories.some((repository) => repository.installationId === installationId && repository.githubRepositoryId === repositoryId) !== true) {
      stale();
      continue;
    }
    projects.push(project);
  }
  return projects;
}

/**
 * Writes the index rows (`GITHUB_REPO#<id>`) of the repositories the project's LATEST revision pins, under the project's own org: nothing for a repository without a pin, nothing for a
 * project with no readable revision, and no row is ever deleted here. A project registered before the index existed has none, so its GitHub triggers could not find it; each call
 * is repeatable and a row already there is written again as it is. Only the latest revision is read, so an older one never decides what the index says.
 */
export async function healGithubRepoIndex(deps: Pick<EventMemoryDeps, "documentClient" | "tableName">, orgId: OrgId, project: string): Promise<number> {
  const latest = await latestRevision(deps, orgId, project);
  const pinned = new Map<number, number>();
  for (const repository of latest?.definition.repositories ?? []) {
    if (repository.installationId !== undefined && repository.githubRepositoryId !== undefined) pinned.set(repository.githubRepositoryId, repository.installationId);
  }
  for (const [githubRepositoryId, installationId] of pinned) {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: { ...githubRepoProjectKey(githubRepositoryId, orgId, project), entityType: "GITHUB_REPO_PROJECT", orgId, project, installationId, githubRepositoryId },
    }));
  }
  return pinned.size;
}

/**
 * The events a signed GitHub body is, for each org and project that holds the repository through this installation. None for a body that is not one of the events triggers can start on,
 * for an installation that is not bound or not active, and for a repository no project of that org pins.
 */
export async function githubTriggerEvents(deps: Pick<GithubTriggerDependencies, "documentClient" | "tableName" | "log" | "githubAppSlug">, input: GithubTriggerInput): Promise<Array<{ orgId: OrgId; event: TriggerEvent }>> {
  const common = Common.safeParse(input.payload);
  if (!common.success) return [];
  const mapped = mapEvent(input.eventName, input.payload, githubUrl(common.data.repository.html_url));
  if (mapped === undefined) return [];
  const orgId = await orgOfInstallation(deps, input.installationId);
  if (orgId === undefined) {
    log(deps)("github.trigger_unbound", { installationId: input.installationId });
    return [];
  }
  const actor = await actorOf(deps, mapped.involved);
  const found: Array<{ orgId: OrgId; event: TriggerEvent }> = [];
  for (const project of await projectsOf(deps, orgId, input.installationId, common.data.repository.id)) {
    const event = TriggerEventSchema.safeParse({
      source: "github", type: mapped.type, eventKey: mapped.eventKey, occurredAt: mapped.occurredAt, project, subject: mapped.subject, fields: mapped.fields, actor,
    });
    if (!event.success) {
      log(deps)("github.trigger_invalid", { orgId, project, type: mapped.type });
      continue;
    }
    found.push({ orgId, event: event.data });
  }
  return found;
}

/** What is remembered of an event, per project: the same pull request in two projects of one org is two starts. */
const memoryKey = (event: TriggerEvent): string => `${event.project}\0${event.eventKey}`;

/**
 * Hands each event to dispatch once: an event outside the age window is dropped, one seen before (the same body under another delivery id) is a duplicate, and one whose dispatch fails
 * is forgotten again and answered with a retryable fault, so that GitHub's redelivery starts it (dispatch's own identity makes a second attempt harmless).
 */
export async function deliverGithubTriggerEvents(deps: GithubTriggerDependencies, input: GithubTriggerInput): Promise<{ events: number; duplicates: number }> {
  const fresh: Array<{ orgId: OrgId; event: TriggerEvent }> = [];
  let duplicates = 0;
  try {
    const found = await githubTriggerEvents(deps, input);
    const now = deps.now();
    for (const entry of found) {
      const outside = outsideEventWindow(entry.event.occurredAt, now);
      if (outside !== undefined) {
        log(deps)(`github.trigger_${outside}`, { orgId: entry.orgId, project: entry.event.project });
        continue;
      }
      if (await firstSight(deps, entry.orgId, GITHUB_HOOK, memoryKey(entry.event), now)) fresh.push(entry);
      else duplicates += 1;
    }
  } catch (error) {
    // A table fault while the events were found or remembered: what was remembered is forgotten, and GitHub is asked to deliver again (a 503, not a failure of ours it would not retry).
    log(deps)("github.trigger_unavailable", { error: error instanceof Error ? error.name : "unknown" });
    for (const left of fresh) await forget(deps, left.orgId, GITHUB_HOOK, [{ ...left.event, eventKey: memoryKey(left.event) }]);
    throw new GithubWebhookRetryableError("GitHub trigger events will be retried");
  }
  for (const [index, entry] of fresh.entries()) {
    try {
      await deps.dispatch(entry.orgId, entry.event);
      await markDispatched(deps, entry.orgId, GITHUB_HOOK, { ...entry.event, eventKey: memoryKey(entry.event) });
    } catch (error) {
      log(deps)("github.trigger_dispatch_failed", { orgId: entry.orgId, project: entry.event.project, error: error instanceof Error ? error.name : "unknown" });
      for (const left of fresh.slice(index)) await forget(deps, left.orgId, GITHUB_HOOK, [{ ...left.event, eventKey: memoryKey(left.event) }]);
      throw new GithubWebhookRetryableError("GitHub trigger events will be retried");
    }
  }
  return { events: fresh.length, duplicates };
}
