// The records that bind one outside surface (a Slack thread, a Linear issue) to one session. Task 2 needs `bindingItems` for a task shared to a
// Slack thread at its start; Task 20 adds the lookups and the later binding on top of it.
import {
  SessionBindingSchema,
  agentSessionKey,
  sessionSurfaceKey,
  type AgentSessionRecord,
  type OrgId,
  type SessionBinding,
  type SessionId,
} from "@agentx/contracts";
import { putNew, type TableInput, type TransactItem } from "../agents/table-writes.js";

/**
 * The two items of one binding: the session's own `BINDING#<kind>` item and the reverse `sessionSurfaceKey` item that says which session a
 * surface follows. Each is written only if absent, so a surface follows one session and a session has one binding of each kind.
 */
export function bindingItems(table: Pick<TableInput, "tableName">, orgId: OrgId, sessionId: SessionId, binding: SessionBinding, at: string): TransactItem[] {
  const clean = SessionBindingSchema.parse(binding);
  const writer = table as TableInput;
  return [
    putNew(writer, agentSessionKey(orgId, sessionId, `BINDING#${clean.kind}`), "AGENT_SESSION_BINDING", { orgId, sessionId, binding: clean, at }),
    putNew(writer, sessionSurfaceKey(orgId, clean), "SESSION_SURFACE", { orgId, sessionId, kind: clean.kind, at }),
  ];
}

export async function bindSessionSurface(_table: TableInput, _input: { orgId: OrgId; sessionId: SessionId; binding: SessionBinding }): Promise<"bound" | "already_bound"> { // eslint-disable-line @typescript-eslint/no-unused-vars -- RED stub
  throw new Error("not built");
}

export async function sessionForSurface(_table: TableInput, _orgId: OrgId, _binding: SessionBinding): Promise<AgentSessionRecord | undefined> { // eslint-disable-line @typescript-eslint/no-unused-vars -- RED stub
  throw new Error("not built");
}
