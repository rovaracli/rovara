// R7: the one place a tracker item (a Linear or Jira webhook, a backfill page, an MCP poller result) becomes a record draft. Everything
// ticket-shaped goes through `createTicketRecorder`, so audience, trust and retention are decided once.
import { createHash } from "node:crypto";
import { addedText, cleanText, gate, isExcluded, linksOf, scalars, withRetention, type GateDependencies } from "./common.js";
import { MAINTAINERS_GROUP, type ActorResolverPort, type PriorEditsPort, type Audience, type RecordDraft, type RecordSinkPort, type SourceConfig, type SourceSystem, type TapLog } from "./ports.js";

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
  /** Who made this change (the webhook's actor, the "last modified by"). On an edit this is the person the row belongs to and is erased with. */
  updaterId?: string;
  /** The source's own id, to ask the source again (existence sweep). Absent: `id`. */
  nativeId?: string;
  /** The item is an edit of one already recorded (an update, not a first sight). */
  edit?: boolean;
  /**
   * Per-editor rows: what this edit changed, as the source said so (Linear's `updatedFrom`, Jira's changelog, GitHub's `changes`). Absent on an edit: unknown, and then no words of the edit are kept
   * (the row says only that someone changed the item), because the text may hold other people's words. A comment's edit changes its body.
   */
  changed?: { title?: boolean; body?: boolean; state?: boolean; labels?: boolean };
  /** The body (or comment text) as it was before this edit, when the source sent it: the editor is credited with the lines they added to it and nothing else. */
  previousBody?: string;
  /** The title as it was before this edit, when the source sent it: a changed title credits the editor with the words they added to it and nothing else. Absent: no title words are kept. */
  previousTitle?: string;
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
  log?: TapLog;
  /** S2: lets a comment edited by its own author, with no earlier text, keep that author's whole text when nobody else edited it before. Absent: such an edit keeps no words. */
  priorEdits?: PriorEditsPort;
  /**
   * The MCP poller sees an item as it is NOW (everyone's edits in it), not who changed what, so a change it reports cannot be put under one person's name. Until a poller says who changed what, its items are not
   * stored (this stays false in production). Tests of the poller's own plumbing set it.
   */
  pollerChangesAttributed?: true;
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

/** The short tag of the person a change row belongs to: two people's changes at the same instant are two rows. */
const tagOf = (sourceId: string | undefined): string => (sourceId === undefined ? "-" : createHash("sha256").update(sourceId).digest("hex").slice(0, 12));

export function createTicketRecorder(deps: TicketRecorderDependencies): TicketRecorder {
  const log: TapLog = deps.log ?? (() => undefined);
  return {
    async record(context, item, preloaded) {
      try {
        const config = preloaded ?? await gate(deps, { workspaceId: context.workspaceId, ...(context.project === undefined ? {} : { project: context.project }), source: item.source, scope: item.scope });
        // S2: a comment edit that is skipped before anyone is looked at (no source row or capture off, the poller's refusal, an unproven parent) is not kept, but its words may be in the comment's text: the item is marked,
        // so the author's later whole-comment credit stays withheld.
        const skippedEdit = async (): Promise<"skipped"> => {
          if (item.edit === true && item.kind === "ticket.comment") await deps.priorEdits?.noteUnstored?.({ workspaceId: context.workspaceId, source: item.source, system: item.system, id: item.id }).catch(() => undefined);
          return "skipped";
        };
        if (config === undefined) return skippedEdit();
        if (item.source === "mcp" && deps.pollerChangesAttributed !== true) { log("record.mcp_change_unattributed", { source: item.source }); return skippedEdit(); }
        // Per-editor rows (owner, 2026-11-02): ONE row per change, under the person who made it. A creation is its author's; an edit (a description, a title, a status, a label, a comment) is its editor's,
        // and holds only that person's own words, so a person's erase takes exactly their rows and nothing else of the item. Nothing is frozen and nothing is replaced.
        const isEdit = item.edit === true;
        const actorId = isEdit ? item.updaterId : item.authorId;
        if (isExcluded(config, item.authorId, actorId, ...(item.labels ?? []))) {
          // S2: an excluded person's edit is not kept, but its words may be in the item's text.
          if (isEdit) await deps.priorEdits?.noteUnstored?.({ workspaceId: context.workspaceId, source: item.source, system: item.system, id: item.id }).catch(() => undefined);
          return "skipped";
        }
        const project = context.project ?? config.project;
        if (item.needsParentProof === true) {
          const proven = item.parentId !== undefined && deps.parents !== undefined
            && await deps.parents.isRecorded({ workspaceId: context.workspaceId, system: item.system, id: item.parentId, scope: item.scope }).catch(() => false);
          if (!proven) return skippedEdit();
        }
        let restricted = item.restricted === true;
        if (item.inheritsRestriction === true && !restricted) {
          const open = item.parentId !== undefined && deps.parents?.isOpen !== undefined
            && await deps.parents.isOpen({ workspaceId: context.workspaceId, system: item.system, id: item.parentId, scope: item.scope }).catch(() => false);
          restricted = !open;
        }
        const resolve = (sourceId: string) => deps.actors.resolve({ workspaceId: context.workspaceId, project, system: item.system, sourceId });
        // The person who made this change. A change nobody is named for (or a person nobody linked) is refused by the sink, which counts it: only a linked person's words can be erased.
        const who = actorId === undefined ? { trust: "outsider" as const } : await resolve(actorId);
        const isComment = item.kind === "ticket.comment";
        const pieces: string[] = [];
        if (!isEdit) {
          for (const part of [item.title, item.body]) if (typeof part === "string" && part !== "") pieces.push(part);
        } else {
          if (item.changed?.title === true) { const added = addedText(item.previousTitle, item.title); if (added !== undefined) pieces.push(added); }
          if (isComment || item.changed?.body === true) {
            let added = addedText(item.previousBody, item.body);
            // Only a comment's own author edits it (an administrator's edit of someone else's comment always sends what it was, or keeps no words): with no earlier text, the editor's whole text is theirs.
            if (added === undefined && isComment && item.previousBody === undefined && item.body !== undefined && item.authorId !== undefined && item.authorId === item.updaterId) {
              // S2: only when nobody else edited this comment before (their words may be in it). A lookup that fails, or no lookup, keeps no words.
              const others = deps.priorEdits === undefined ? true : await deps.priorEdits.editedByOthers({ workspaceId: context.workspaceId, source: item.source, system: item.system, id: item.id, actorSourceId: item.authorId }).catch(() => true);
              if (!others) added = item.body;
            }
            if (added !== undefined) pieces.push(added);
          }
        }
        const text = cleanText(pieces.join("\n\n"));
        const changedWords = isEdit ? Object.entries(item.changed ?? {}).filter(([, on]) => on === true).map(([name]) => name).join(",") : "";
        const structured = isEdit
          ? scalars({ edit: true, changed: item.changed === undefined ? "unknown" : changedWords, ...(item.changed?.state === true ? { state: item.state } : {}), ...(item.changed?.labels === true ? { labels: item.labels?.slice(0, 20).join(",") } : {}), restricted })
          : scalars({ state: item.state, labels: item.labels?.slice(0, 20).join(","), restricted });
        const occurredMs = Date.parse(item.occurredAt);
        const draft: RecordDraft = {
          workspaceId: context.workspaceId, ...(project === undefined ? {} : { project }), source: item.source, kind: item.kind, occurredAt: item.occurredAt,
          sourceRef: {
            system: item.system, id: item.id, nativeId: item.nativeId ?? item.id, ...(linksOf(item.url)[0] === undefined ? {} : { url: linksOf(item.url)[0]! }), ...(item.parentId === undefined ? {} : { parentId: item.parentId }),
            version: `${item.version}:${tagOf(actorId)}`.slice(0, 100), order: Number.isFinite(occurredMs) && occurredMs >= 0 ? Math.floor(occurredMs) : 0,
          },
          ...(actorId === undefined ? {} : { actor: { sourceId: actorId, ...(who.developerId === undefined ? {} : { developerId: who.developerId }), trust: who.trust } }),
          trust: who.trust, scope: item.scope, pieceTrusts: [who.trust], audience: ticketAudience({ source: item.source, scope: item.scope, restricted }, item.acl, config, item.occurredAt), ...(text === undefined ? {} : { text }),
          structured, links: linksOf(item.url), retention: config.retention,
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
