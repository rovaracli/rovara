// R7: the one place a tracker item (a Linear or Jira webhook, a backfill page, an MCP poller result) becomes a record draft. Everything
// ticket-shaped goes through `createTicketRecorder`, so audience, trust and retention are decided once.
import { cleanText, gate, isExcluded, linksOf, scalars, withRetention, type GateDependencies } from "./common.js";
import { MAINTAINERS_GROUP, type ActorResolverPort, type Audience, type RecordDraft, type RecordSinkPort, type SourceConfig, type SourceSystem, type TapLog } from "./ports.js";

export interface TicketAcl {
  principals?: readonly string[];
  groups?: readonly string[];
  /**
   * True when the source itself said who may see the item (an MCP server's own ACL). It always narrows. False when the adapter only derived a default
   * scope (a Linear team, a Jira project): the admin's "visible to all project members" setting then widens it.
   */
  strict: boolean;
}

/** One tracker item, a comment, or a wiki page, in the source's own terms but a fixed shape. */
export interface TicketItem {
  source: Extract<SourceSystem, "linear" | "jira" | "mcp">;
  /** The source instance: `linear`, `jira:<site host>`, or an MCP server id. */
  system: string;
  /** The item's stable id in the source. Comments use a different prefix than their ticket. */
  id: string;
  kind: "ticket.created" | "ticket.updated" | "ticket.comment";
  /** The `SOURCE#` scope this item belongs to, for example `linear:team/T`, `jira:project/KEY`, `mcp:sim/folder`. */
  scope: string;
  parentId?: string;
  title?: string;
  body?: string;
  state?: string;
  labels?: readonly string[];
  url?: string;
  authorId?: string;
  occurredAt: string;
  /** What changed it: the update time, or the action plus the time. Makes the write idempotent per version. */
  version: string;
  acl?: TicketAcl;
}

export interface TicketRecorderDependencies extends GateDependencies {
  sink: RecordSinkPort;
  actors: ActorResolverPort;
  log?: TapLog;
}

export interface TicketContext {
  workspaceId: string;
  project?: string;
}

export interface TicketRecorder {
  record(context: TicketContext, item: TicketItem, preloaded?: SourceConfig): Promise<"stored" | "duplicate" | "skipped" | "refused" | "failed">;
  /** A delete at the source. Honoured whatever the mode or the source row says now. */
  remove(context: TicketContext, input: { source: TicketItem["source"]; system: string; ids: readonly string[] }): Promise<void>;
}

export function ticketAudience(item: Pick<TicketItem, "source" | "scope">, acl: TicketAcl | undefined, config: SourceConfig, at: string): Audience {
  if (acl !== undefined && (acl.strict || config.audienceDefault !== "project")) {
    const principals = (acl.principals ?? []).slice(0, 500);
    const groups = (acl.groups ?? []).slice(0, 100);
    if (principals.length > 0 || groups.length > 0) {
      return { kind: "restricted", acl: { source: item.source, scope: item.scope, ...(principals.length === 0 ? {} : { principals }), ...(groups.length === 0 ? {} : { groups }), capturedAt: at, liveCheck: "none" } };
    }
  }
  if (config.audienceDefault === "project" && (acl === undefined || !acl.strict)) return { kind: "project" };
  // Fail closed: no ACL from the source and no admin say-so means the project's maintainers only.
  return { kind: "restricted", acl: { source: item.source, scope: item.scope, groups: [MAINTAINERS_GROUP], capturedAt: at, liveCheck: "none" } };
}

export function createTicketRecorder(deps: TicketRecorderDependencies): TicketRecorder {
  const log: TapLog = deps.log ?? (() => undefined);
  return {
    async record(context, item, preloaded) {
      try {
        const config = preloaded ?? await gate(deps, { workspaceId: context.workspaceId, ...(context.project === undefined ? {} : { project: context.project }), source: item.source, scope: item.scope });
        if (config === undefined) return "skipped";
        if (isExcluded(config, item.authorId, ...(item.labels ?? []))) return "skipped";
        const project = context.project ?? config.project;
        // An author the source names but the company has not linked is an outsider; no author at all is too.
        const who = item.authorId === undefined
          ? { trust: "outsider" as const }
          : await deps.actors.resolve({ workspaceId: context.workspaceId, project, system: item.system, sourceId: item.authorId });
        const text = cleanText([item.title, item.body].filter((part): part is string => typeof part === "string" && part !== "").join("\n\n"));
        const draft: RecordDraft = {
          workspaceId: context.workspaceId, ...(project === undefined ? {} : { project }), source: item.source, kind: item.kind, occurredAt: item.occurredAt,
          sourceRef: { system: item.system, id: item.id, ...(linksOf(item.url)[0] === undefined ? {} : { url: linksOf(item.url)[0]! }), ...(item.parentId === undefined ? {} : { parentId: item.parentId }), version: item.version },
          ...(item.authorId === undefined ? {} : { actor: { sourceId: item.authorId, ...(who.developerId === undefined ? {} : { developerId: who.developerId }), trust: who.trust } }),
          trust: who.trust, audience: ticketAudience(item, item.acl, config, item.occurredAt), ...(text === undefined ? {} : { text }),
          structured: scalars({ state: item.state, labels: item.labels?.slice(0, 20).join(","), }), links: linksOf(item.url), retention: config.retention,
        };
        const outcome = await deps.sink.put(withRetention(draft, config.retention));
        return outcome.status;
      } catch {
        log("record.ticket_failed", { source: item.source });
        return "failed";
      }
    },
    async remove(context, input) {
      if (input.ids.length === 0) return;
      await deps.sink.tombstone({ workspaceId: context.workspaceId, system: input.system, sourceIds: input.ids.slice(0, 500), cause: "source_deleted" });
    },
  };
}
