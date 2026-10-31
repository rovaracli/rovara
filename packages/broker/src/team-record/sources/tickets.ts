// R7: the one place a tracker item (a Linear or Jira webhook, a backfill page, an MCP poller result) becomes a record draft. Everything
// ticket-shaped goes through `createTicketRecorder`, so audience, trust and retention are decided once.
import { cleanText, gate, isExcluded, linksOf, scalars, withRetention, type GateDependencies } from "./common.js";
import { lowestTrust, MAINTAINERS_GROUP, type ActorResolverPort, type RecordHistoryPort, type TrustClass, type Audience, type RecordDraft, type RecordSinkPort, type SourceConfig, type SourceSystem, type TapLog } from "./ports.js";

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
  /**
   * Who WROTE the text (a ticket's creator or reporter, a comment's author), never whoever last touched it. Trust follows this person: an outsider's ticket
   * does not become a member's because a member changed its status. Absent: the author is unknown, which is an outsider.
   */
  authorId?: string;
  /** Who made this change (the webhook's actor, the "last modified by"). Kept as data; it can only lower the row's trust, never raise it. */
  updaterId?: string;
  /** The source's own id, to ask the source again (existence sweep). Absent: `id`. */
  nativeId?: string;
  /** The item is an edit of one already recorded (an update, not a first sight). */
  edit?: boolean;
  /** The source marks the item as restricted inside its team or project (a Jira issue security level): maintainers only, whatever the admin widened. */
  restricted?: boolean;
  /**
   * A comment takes its parent issue's restriction (a Jira comment webhook carries a reduced `issue.fields`, usually without the security level). It is
   * recorded as open only when the parent is recorded under the scope and was recorded as NOT restricted (`ParentLookupPort.isOpen`); a parent that is not
   * known, a lookup that fails or a missing port all mean restricted (maintainers only). A comment's own visibility restriction is `restricted`.
   */
  inheritsRestriction?: boolean;
  /** The body could not prove which team or project the item belongs to (a Linear comment names only its issue): it is recorded only if its parent is already recorded under this scope. */
  needsParentProof?: boolean;
  occurredAt: string;
  /** What changed it: the update time, or the action plus the time. Makes the write idempotent per version. */
  version: string;
  acl?: TicketAcl;
}

/** Whether an item (a ticket) is already recorded under a scope: how a comment that names only its ticket proves which team it belongs to. */
export interface ParentLookupPort {
  isRecorded(input: { workspaceId: string; system: string; id: string; scope: string }): Promise<boolean>;
  /** The parent is recorded under the scope with `structured.restricted === false`. Absent on the port: no parent is known open. */
  isOpen?(input: { workspaceId: string; system: string; id: string; scope: string }): Promise<boolean>;
}

export interface TicketRecorderDependencies extends GateDependencies {
  sink: RecordSinkPort;
  actors: ActorResolverPort;
  parents?: ParentLookupPort;
  /**
   * Sticky trust: the lowest trust any earlier version of the item ever had (the sink, `RecordHistoryPort`). Without it an outsider's edit to a member's ticket
   * is relabelled `member` by the next innocent touch (a status change) that carries the same text with the member as creator. In production it is required; an
   * edit whose history cannot be read is recorded as an outsider's.
   */
  history?: RecordHistoryPort;
  log?: TapLog;
}

export interface TicketContext {
  workspaceId: string;
  project?: string;
}

export interface TicketRecorder {
  record(context: TicketContext, item: TicketItem, preloaded?: SourceConfig): Promise<"stored" | "duplicate" | "queued" | "skipped" | "refused" | "failed">;
  /** A delete at the source. Honoured whatever the mode or the source row says now. */
  remove(context: TicketContext, input: { source: TicketItem["source"]; system: string; ids: readonly string[] }): Promise<void>;
}

export function ticketAudience(item: Pick<TicketItem, "source" | "scope"> & { restricted?: boolean }, acl: TicketAcl | undefined, config: SourceConfig, at: string): Audience {
  // A restricted item (a Jira security level) is never widened by the admin's "visible to all project members".
  if (item.restricted === true) {
    const own = acl?.strict === true ? acl : undefined;
    const principals = (own?.principals ?? []).slice(0, 500);
    const groups = (own?.groups ?? []).slice(0, 100);
    if (principals.length > 0 || groups.length > 0) {
      return { kind: "restricted", acl: { source: item.source, scope: item.scope, ...(principals.length === 0 ? {} : { principals }), ...(groups.length === 0 ? {} : { groups }), capturedAt: at, liveCheck: "none" } };
    }
    return { kind: "restricted", acl: { source: item.source, scope: item.scope, groups: [MAINTAINERS_GROUP], capturedAt: at, liveCheck: "none" } };
  }
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
        if (item.needsParentProof === true) {
          const proven = item.parentId !== undefined && deps.parents !== undefined
            && await deps.parents.isRecorded({ workspaceId: context.workspaceId, system: item.system, id: item.parentId, scope: item.scope }).catch(() => false);
          if (!proven) return "skipped";
        }
        let restricted = item.restricted === true;
        if (item.inheritsRestriction === true && !restricted) {
          const open = item.parentId !== undefined && deps.parents?.isOpen !== undefined
            && await deps.parents.isOpen({ workspaceId: context.workspaceId, system: item.system, id: item.parentId, scope: item.scope }).catch(() => false);
          restricted = !open;
        }
        // Trust follows the person who wrote the text. An author the source names but the company has not linked is an outsider; so is no author at all.
        // Whoever made this change can only lower it: an outsider who edits a member's ticket makes that version an outsider's.
        const resolve = (sourceId: string) => deps.actors.resolve({ workspaceId: context.workspaceId, project, system: item.system, sourceId });
        const who = item.authorId === undefined ? { trust: "outsider" as const } : await resolve(item.authorId);
        const updater = item.updaterId === undefined || item.updaterId === item.authorId ? undefined : await resolve(item.updaterId);
        let previous: TrustClass | undefined;
        if (deps.history !== undefined) {
          try {
            previous = await deps.history.lowestTrust({ workspaceId: context.workspaceId, source: item.source, system: item.system, id: item.id });
          } catch {
            // A history that cannot be read is not "no history": the text may be someone else's.
            previous = "outsider";
          }
        }
        const trust = lowestTrust(who.trust, ...(updater === undefined ? [] : [updater.trust]), ...(previous === undefined ? [] : [previous]));
        const text = cleanText([item.title, item.body].filter((part): part is string => typeof part === "string" && part !== "").join("\n\n"));
        const draft: RecordDraft = {
          workspaceId: context.workspaceId, ...(project === undefined ? {} : { project }), source: item.source, kind: item.kind, occurredAt: item.occurredAt,
          sourceRef: { system: item.system, id: item.id, nativeId: item.nativeId ?? item.id, ...(linksOf(item.url)[0] === undefined ? {} : { url: linksOf(item.url)[0]! }), ...(item.parentId === undefined ? {} : { parentId: item.parentId }), version: item.version },
          ...(item.authorId === undefined ? {} : { actor: { sourceId: item.authorId, ...(who.developerId === undefined ? {} : { developerId: who.developerId }), trust: who.trust } }),
          trust, scope: item.scope, pieceTrusts: [who.trust, ...(updater === undefined ? [] : [updater.trust]), ...(previous === undefined ? [] : [previous])], audience: ticketAudience({ source: item.source, scope: item.scope, restricted }, item.acl, config, item.occurredAt), ...(text === undefined ? {} : { text }),
          structured: scalars({ state: item.state, labels: item.labels?.slice(0, 20).join(","), updatedBy: item.updaterId, restricted }), links: linksOf(item.url), retention: config.retention,
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
