// Tracker intake on the core (area 18): Code's fake tracker as the registry's `tracker` adapter, the project's intake source set through the core's own
// route, one poll (`runtime.tick`), the waiting list, and Start through the route, as the owner's page would. Same ticket and words as Cloud's (intake.ts).
import { FAKE_TRACKER_KIND } from "../../../../vendor/rovara-code/packages/broker/src/plugins/fake/tracker.js";
import type { CoreContext } from "../core-context.js";
import { INTAKE_LABEL, INTAKE_SOURCE, INTAKE_SYSTEM, INTAKE_TICKET } from "./intake.js";
import { outcome } from "./outcomes.js";

export async function runCoreIntake(ctx: CoreContext): Promise<string[]> {
  const tracker = ctx.world.tracker;
  if (tracker === undefined || INTAKE_SYSTEM !== FAKE_TRACKER_KIND) throw new Error("the core engine has no tracker adapter (FakeWorldOptions.tracker)");
  if ((await ctx.api("/v1/admin/projects", { method: "POST", body: ctx.project })).status !== 201) throw new Error("the core refused the project");
  const set = await ctx.api("/v1/app/projects/payments/intake/sources", { method: "POST", body: { sources: [INTAKE_SOURCE] } });
  if (set.status !== 200) throw new Error(`the core refused the intake source (${String(set.status)}): ${JSON.stringify(set.body).slice(0, 200)}`);
  tracker.addItem(INTAKE_TICKET.id, { title: INTAKE_TICKET.title, labels: [INTAKE_LABEL] });
  tracker.asked = [{
    ref: { tracker: FAKE_TRACKER_KIND, id: INTAKE_TICKET.id, url: `https://host.example.test/items/${INTAKE_TICKET.id}` }, title: INTAKE_TICKET.title, body: INTAKE_TICKET.body, reporter: INTAKE_TICKET.reporter,
    actor: { kind: "person", account: { provider: FAKE_TRACKER_KIND, tenant: "", accountId: INTAKE_TICKET.account } },
  }] as typeof tracker.asked;
  const tasksBefore = ((await ctx.api("/v1/dev/tasks")).body.tasks as unknown[] | undefined)?.length ?? 0;
  await ctx.runtime.tick();
  const tasksAfterPoll = ((await ctx.api("/v1/dev/tasks")).body.tasks as unknown[] | undefined)?.length ?? 0;
  const list = (await ctx.api("/v1/app/projects/payments/intake")).body as { items?: Array<{ itemId: string; reason?: string }> };
  const items = list.items ?? [];
  const words = [outcome("intake", `poll:started:${String(tasksAfterPoll - tasksBefore)}`), outcome("intake", `poll:waiting:${String(items.length)}`), ...items.map((item) => outcome("intake", `waiting:${String(item.reason)}`))];
  if (items[0] === undefined) return words;
  const writesBefore = tracker.writes.length;
  const started = await ctx.api(`/v1/app/projects/payments/intake/${items[0].itemId}/start`, { method: "POST", body: { requestId: "66666666-6666-4666-8666-666666666666" } });
  const outcomeWord = started.status === 202 && started.body.started === true ? "started" : `refused_${String(started.status)}`;
  await ctx.runtime.tick();
  const wrote = tracker.writes.slice(writesBefore).filter((write) => write.item === INTAKE_TICKET.id);
  words.push(outcome("intake", `start:${outcomeWord}`), outcome("intake", `writeback:${wrote.length > 0 ? "started" : "none"}`));
  return words;
}
