// The setup run (SH15): read its state and journal, start it, stop it, type a command, and "Use this setup". Readers project the existing routes; the broker owns who may do what (a project maintainer only; a
// command needs a fresh browser sign-in) and decides everything, so this client only asks. The gateway puts its own `requestId` in every answer and the contracts are strict, so it is set aside first.
import { useMemo } from "react";
import {
  ProjectOverviewProjectSchema, SetupAgentCommandReplySchema, SetupAgentCommandRequestSchema, SetupAgentRequestBodySchema, SetupAgentViewSchema, SetupConfirmReplySchema, SetupConfirmRequestSchema, SetupDecideReplySchema, SetupDecideRequestSchema, SetupDiscardReplySchema, SetupDiscardRequestSchema, SetupHostDecideReplySchema, SetupHostDecideRequestSchema, SetupJournalReplySchema,
} from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

function exactAnswer<T>(schema: { parse(value: unknown): T }): { parse(value: unknown): T } {
  return { parse(value: unknown): T { if (typeof value !== "object" || value === null || Array.isArray(value)) return schema.parse(value); const own = { ...value } as Record<string, unknown>; delete own["requestId"]; return schema.parse(own); } };
}

export function createSetupAgentApi(host: AppHost) {
  const api = createApiClient(host);
  const base = (name: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(name)) + "/setup-agent";
  const view = exactAnswer(SetupAgentViewSchema);
  return {
    read: (name: string) => api.get(base(name), view),
    journal: (name: string, options?: { retry: "never" }) => api.get(base(name) + "/journal", exactAnswer(SetupJournalReplySchema), undefined, options),
    start: (name: string, requestId: string) => api.sendAnswer("POST", base(name), SetupAgentRequestBodySchema.parse({ requestId }), view),
    stop: (name: string, requestId: string) => api.sendAnswer("POST", base(name) + "/stop", SetupAgentRequestBodySchema.parse({ requestId }), view),
    command: (name: string, requestId: string, command: string) => api.sendAnswer("POST", base(name) + "/command", SetupAgentCommandRequestSchema.parse({ requestId, command }), exactAnswer(SetupAgentCommandReplySchema)),
    confirm: (name: string, body: ReturnType<typeof SetupConfirmRequestSchema.parse>) => api.sendAnswer("POST", base(name) + "/confirm", SetupConfirmRequestSchema.parse(body), exactAnswer(SetupConfirmReplySchema)),
    /** L4-D2: drop the waiting candidate. */
    discard: (name: string, requestId: string) => api.sendAnswer("POST", base(name) + "/discard", SetupDiscardRequestSchema.parse({ requestId }), exactAnswer(SetupDiscardReplySchema)),
    /** L4-D2: approve or reject the waiting candidate, bound to the id, revision and digest the read offered. Never sent twice by the client. */
    /** Allow or refuse one website a run asked for, bound to the id and digest the journal offered for that ask. Never sent twice by the client: an unknown outcome is checked through reads. */
    hostDecide: (name: string, body: ReturnType<typeof SetupHostDecideRequestSchema.parse>) => api.sendAnswer("POST", base(name) + "/host-decide", SetupHostDecideRequestSchema.parse(body), exactAnswer(SetupHostDecideReplySchema), { retry: "never" }),
    decide: (name: string, body: ReturnType<typeof SetupDecideRequestSchema.parse>) => api.sendAnswer("POST", base(name) + "/decide", SetupDecideRequestSchema.parse(body), exactAnswer(SetupDecideReplySchema), { retry: "never" }),
  };
}

export function useSetupAgentApi() {
  const host = useAppHost();
  return useMemo(() => createSetupAgentApi(host), [host]);
}
