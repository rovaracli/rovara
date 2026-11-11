// Stdio MCP host redesign (T10): how the controller tells the broker what happened to a package-run server. Each event is one small item in a partition of its own in the install's table
// (`ORG#<org>#MCPEVT`), written with a conditional put so a retry cannot make two. The controller's role may write that partition and no other item of the table with it; the broker reads
// it to record audit events and to show the "recent starts" line (context-sources/controller-events.ts).
//
// Bounded: at most `maxPerWindow` events in a window (a crash loop is already slowed by the controller's backoff; this stops it from filling the table), and nothing is waited for.
import { randomBytes } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { McpControllerEventSchema, orgScoped, type McpControllerEvent, type OrgId } from "@rovara-code/contracts";
import type { ControllerEvent } from "@agentx/gateway";

type DocumentClient = { send(command: unknown): Promise<unknown> };

export const CONTROLLER_EVENT_WINDOW_MS = 10 * 60_000;
export const CONTROLLER_EVENT_MAX_PER_WINDOW = 200;
/** The sort key prefix of an event item: `EVT#<iso time>#<random>`, so a partition reads in time order. */
export const CONTROLLER_EVENT_PREFIX = "EVT#";

export interface ControllerEventSink {
  /** The controller's own events (starts, stops, a pause). */
  record(event: ControllerEvent): Promise<void>;
  /** A change to what a server may reach: counts and the approved names, not the addresses' owners. Nothing is written for a change that changed nothing. */
  egress(change: { serverId: string; hosts: string[]; added: string[]; removed: string[] }): Promise<void>;
  /** How many events were dropped because the window was full. */
  dropped(): number;
}

export function dynamoControllerEvents(options: { documentClient: DocumentClient; tableName: string; orgId: OrgId; now?: () => number; random?: () => string; maxPerWindow?: number; windowMs?: number; log?: (event: string, fields: Record<string, string | number>) => void }): ControllerEventSink {
  const now = options.now ?? Date.now;
  const random = options.random ?? (() => randomBytes(6).toString("hex"));
  const max = options.maxPerWindow ?? CONTROLLER_EVENT_MAX_PER_WINDOW;
  const windowMs = options.windowMs ?? CONTROLLER_EVENT_WINDOW_MS;
  const partition = orgScoped(options.orgId, "MCPEVT");
  const times: number[] = [];
  let dropped = 0;
  async function write(event: McpControllerEvent): Promise<void> {
    const at = now();
    while (times.length > 0 && at - times[0]! >= windowMs) times.shift();
    if (times.length >= max) { dropped += 1; options.log?.("mcp_controller.event_dropped", { type: event.type }); return; }
    times.push(at);
    // The shape is checked here, so the controller can never write a field the broker would refuse to read.
    const checked = McpControllerEventSchema.parse(event);
    try {
      await options.documentClient.send(new PutCommand({
        TableName: options.tableName, Item: { pk: partition, sk: `${CONTROLLER_EVENT_PREFIX}${checked.at}#${random()}`, ...checked }, ConditionExpression: "attribute_not_exists(pk)",
      }));
    } catch {
      options.log?.("mcp_controller.event_write_failed", { type: event.type });
    }
  }
  const stamp = (): string => new Date(now()).toISOString();
  return {
    async record(event) {
      if (event.type === "task_started") return write({ type: "task_started", serverId: event.serverId, at: stamp(), trigger: event.trigger });
      if (event.type === "task_stopped") return write({ type: "task_stopped", serverId: event.serverId, at: stamp(), reason: event.reason });
      return write({ type: "changed_needs_review", serverId: event.serverId, at: stamp(), approved: event.approved, observed: event.observed });
    },
    async egress(change) {
      if (change.added.length === 0 && change.removed.length === 0) return;
      const list = (items: string[]): string => items.slice(0, 16).join(",");
      const addresses = `for ${list(change.hosts)}; added ${list(change.added)}; removed ${list(change.removed)}`.slice(0, 900);
      return write({ type: "egress_updated", serverId: change.serverId, at: stamp(), added: change.added.length, removed: change.removed.length, addresses });
    },
    dropped: () => dropped,
  };
}
