// Tracker intake (area 18) in one vocabulary on both engines: a ticket labelled `rovara` by a tracker account nobody in the company is linked to. Both
// products' intake engines (Cloud's intake/engine.ts and the core's core/intake/engine.ts, the core's a port of Cloud's) make it wait (reason `unlinked`);
// a person who may start work says Start; the task starts and the ticket hears it.
//   intake:poll:started:<n>  intake:poll:waiting:<n>  intake:waiting:<reason>  intake:start:<outcome>  intake:writeback:<what>
import { FakeDynamoDb } from "../../../support/fake-dynamodb.js";
import type { IntakeChannelRef, OrgId } from "@rovara-code/contracts";
import { startWaitingIntake, type IntakePorts } from "../../../../packages/broker/src/intake/engine.js";
import { replaceIntakeSources } from "../../../../packages/broker/src/intake/sources.js";
import { listWaitingIntakeItems } from "../../../../packages/broker/src/intake/store.js";
import { runIntakePoll } from "../../../../packages/broker/src/triggers/poll-intake.js";
import { outcome } from "./outcomes.js";

export const INTAKE_SYSTEM = "fake-tracker";
export const INTAKE_LABEL = "rovara";
export const INTAKE_SOURCE: IntakeChannelRef = { channel: "tracker", system: INTAKE_SYSTEM, when: { label: INTAKE_LABEL } };
export const INTAKE_TICKET = { id: "T-1", title: "Refunds fail", body: "Refunds over 100 fail.", reporter: "Dana", account: "u-stranger" };

const ORG = "org_s0parity00000000000a" as OrgId;
const MEMBER = "d".repeat(64);

/** Cloud's intake over its own store rows, with the poll test's ports (the journey harness has no intake wiring). */
export async function runCloudIntake(): Promise<string[]> {
  const db = new FakeDynamoDb();
  const now = Date.parse("2026-11-12T10:00:00.000Z");
  const started: string[] = [];
  const told: string[] = [];
  const ports: IntakePorts = {
    table: { documentClient: db, tableName: "state", now: () => now },
    log: () => undefined,
    // No tracker account is linked to a member, as on the core engine (its install config links none).
    memberOfAccount: async () => undefined,
    mayStart: async () => true,
    start: async (_org, developerId, request) => {
      started.push(`${developerId}:${request.binding?.kind === "tracker_item" ? request.binding.id : ""}`);
      return { task: { taskId: "11111111-2222-4333-8444-555555555555" }, sessionId: `ses_${"1".repeat(20)}` };
    },
    sessionOfTicket: async () => undefined,
    started: async () => { told.push("started"); },
  };
  await replaceIntakeSources(ports.table, { orgId: ORG, project: "payments", refs: [INTAKE_SOURCE], setBy: MEMBER });
  const report = await runIntakePoll({
    ports,
    searchFor: (system) => (system !== INTAKE_SYSTEM ? undefined : async () => [{
      externalRef: { system: INTAKE_SYSTEM, id: INTAKE_TICKET.id, url: `https://host.example.test/items/${INTAKE_TICKET.id}` },
      title: INTAKE_TICKET.title, body: INTAKE_TICKET.body, reporter: { display: INTAKE_TICKET.reporter },
      actor: { kind: "person", accountId: INTAKE_TICKET.account },
    }]),
    notify: async () => undefined,
    searchTimeoutMs: 5_000,
  });
  const words = [outcome("intake", `poll:started:${String(report.started)}`), outcome("intake", `poll:waiting:${String(report.waiting)}`)];
  const waiting = await listWaitingIntakeItems(ports.table, ORG, "payments");
  words.push(...waiting.map((item) => outcome("intake", `waiting:${String(item.reason)}`)));
  if (waiting[0] === undefined) return words;
  const start = await startWaitingIntake(ports, { orgId: ORG, project: "payments", itemId: waiting[0].itemId, approver: MEMBER });
  words.push(outcome("intake", `start:${start.outcome}`), outcome("intake", `writeback:${told.length > 0 ? "started" : "none"}`));
  return words;
}
