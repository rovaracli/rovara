// Slice 5 "Outside tools": intake on Home. Two sources of cards, each built for the caller alone and read live:
//   - `waiting_ticket`: a ticket from Linear, Jira or GitHub that waits for a member, shown to the people who may START tasks in its project now (`start_tasks`, read through the project
//     members), with the reason it waits and two buttons: Start (the work is theirs) and Not this one. At most 10 projects and 20 tickets each are read per call.
//   - `intake_source`: a watched (polled) tracker source that keeps failing, shown to the project's maintainers (`edit_settings`). The notices the poll writes to the maintainer's own partition
//     (`intake/notices.ts`, INTAKE_NOTICES#) are read here; a card shows for a source that is failing NOW and was noticed, or has failed for an hour. It opens the project's settings.
// The ticket's title is the ticket's own words (stored inert and cut) and is shown as text; no link is built from it. Nothing here starts or changes anything.
import { createHash } from "node:crypto";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { INTAKE_SOURCE_ERROR_WORDS, INTAKE_WAIT_REASON_WORDS, intakeNoticeKey, intakeSystemOf, projectAllows, type IntakeWaitReason, type OrgId } from "@agentx/contracts";
import { fit, quoted, registerHomeCardSource, type HomeCardSource, type HomeSourceCard } from "../agent-sessions/home.js";
import { INTAKE_NOTICE_AFTER_MS } from "../triggers/poll-intake.js";
import { listIntakeSources } from "./sources.js";
import { listWaitingIntakeItems } from "./store.js";

export const INTAKE_HOME_PROJECTS_MAX = 10;
export const INTAKE_HOME_TICKETS_PER_PROJECT = 20;
export const INTAKE_HOME_NOTICES_READ = 50;

type Item = Record<string, unknown>;
const hashOf = (orgId: string, project: string): string => `ph_${createHash("sha256").update(`${orgId}\n${project}`, "utf8").digest("hex").slice(0, 24)}`;
const TRACKER_NAMES: Readonly<Record<string, string>> = { jira: "Jira", github: "GitHub", linear: "Linear" };
const trackerName = (system: string): string => (Object.hasOwn(TRACKER_NAMES, system) ? TRACKER_NAMES[system]! : "Tracker");
const reasonWords = (reason: string): string => (Object.hasOwn(INTAKE_WAIT_REASON_WORDS, reason) ? INTAKE_WAIT_REASON_WORDS[reason as IntakeWaitReason] : INTAKE_WAIT_REASON_WORDS.outsider);

async function projectsWhere(deps: Parameters<HomeCardSource["list"]>[0], caller: Parameters<HomeCardSource["list"]>[1], action: "start_tasks" | "edit_settings"): Promise<string[]> {
  const members = deps.approvals?.projectMembers;
  if (members === undefined) return [];
  return (await members.projectsOf(caller.orgId, { developerId: caller.developerId, orgRole: caller.orgRole }))
    .filter((entry) => projectAllows(entry.role, action)).map((entry) => entry.project).sort().slice(0, INTAKE_HOME_PROJECTS_MAX);
}

export const waitingTicketHomeSource: HomeCardSource = {
  kind: "waiting_ticket",
  async list(deps, caller): Promise<HomeSourceCard[]> {
    const projects = await projectsWhere(deps, caller, "start_tasks");
    if (projects.length === 0) return [];
    const origin = deps.origin.replace(/\/+$/u, "");
    const table = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now };
    const cards: HomeSourceCard[] = [];
    for (const project of projects) {
      const waiting = await listWaitingIntakeItems(table, caller.orgId, project, INTAKE_HOME_TICKETS_PER_PROJECT);
      const base = `${origin}/v1/app/projects/${encodeURIComponent(project)}/intake`;
      for (const item of waiting) {
        cards.push({
          cardId: `waiting_ticket:${hashOf(caller.orgId, project)}_${item.itemId}`, kind: "waiting_ticket",
          title: fit(`${trackerName(item.system)} ${item.id}: `, item.title === "" ? "(no title)" : item.title),
          reason: fit(`Waiting to start in ${quoted(project)}. `, reasonWords(item.reason ?? "outsider")),
          at: item.since,
          buttons: [
            { label: "Start", action: "start", href: `${base}/${item.itemId}/start`, method: "POST" },
            { label: "Not this one", action: "dismiss", href: `${base}/${item.itemId}/dismiss`, method: "POST" },
          ],
        });
      }
    }
    return cards;
  },
};

/** The sources the poll noticed for this maintainer in the last 30 days (project and source id), from their own notice partition. */
async function noticedSources(deps: Parameters<HomeCardSource["list"]>[0], orgId: OrgId, developerId: string): Promise<Set<string>> {
  const pk = intakeNoticeKey(orgId, developerId, new Date(0).toISOString(), "x").pk;
  const page = (await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, ScanIndexForward: false, Limit: INTAKE_HOME_NOTICES_READ, ConsistentRead: true,
  }))) as { Items?: Item[] };
  const found = new Set<string>();
  for (const item of page.Items ?? []) {
    if (item["orgId"] === orgId && item["developerId"] === developerId && typeof item["project"] === "string" && typeof item["sourceId"] === "string") found.add(`${item["project"]}\0${item["sourceId"]}`);
  }
  return found;
}

export const intakeSourceHomeSource: HomeCardSource = {
  kind: "intake_source",
  async list(deps, caller): Promise<HomeSourceCard[]> {
    const projects = await projectsWhere(deps, caller, "edit_settings");
    if (projects.length === 0) return [];
    const table = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now };
    const noticed = await noticedSources(deps, caller.orgId, caller.developerId);
    const origin = deps.origin.replace(/\/+$/u, "");
    const now = deps.now();
    const cards: HomeSourceCard[] = [];
    for (const project of projects) {
      for (const source of await listIntakeSources(table, caller.orgId, project)) {
        // Live: a source that works again has no card, whatever was noticed.
        if (source.failures === 0 || source.failingSince === undefined) continue;
        if (!noticed.has(`${project}\0${source.sourceId}`) && now - source.failingSince < INTAKE_NOTICE_AFTER_MS) continue;
        const code = source.lastError ?? "SEARCH_FAILED";
        const words = Object.hasOwn(INTAKE_SOURCE_ERROR_WORDS, code) ? INTAKE_SOURCE_ERROR_WORDS[code]! : INTAKE_SOURCE_ERROR_WORDS["SEARCH_FAILED"]!;
        cards.push({
          cardId: `intake_source:${hashOf(caller.orgId, project)}_${source.sourceId}`, kind: "intake_source",
          title: fit(`Rovara can't read the ${trackerName(intakeSystemOf(source.ref))} tickets for `, quoted(project)),
          reason: fit("", `${words} Nothing was started, and nothing will be started twice.`),
          at: new Date(source.failingSince).toISOString(),
          buttons: [{ label: "Open settings", action: "open", href: `${origin}/app/projects/${encodeURIComponent(project)}#tickets`, method: "GET" }],
        });
      }
    }
    return cards;
  },
};

registerHomeCardSource(waitingTicketHomeSource);
registerHomeCardSource(intakeSourceHomeSource);
