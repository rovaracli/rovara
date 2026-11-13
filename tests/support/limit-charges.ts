// Convergence lane A5 (owner decision 60, item S2): a charged task is a marker item beside its member counter (`TASK#<taskId>`, naming the counter in
// `memberSk`), not an entry of the counter's old `tasks` set. Tests that look at what a counter holds read both forms through these helpers, so the same
// assertion holds for rows written before the switch (a set) and after it (markers).
import type { FakeDynamoDb } from "./fake-dynamodb.js";

type Key = { pk: string; sk: string };
type Row = Record<string, unknown>;
/** What `heldTasks` reads: a fake table, or a journey's view of one. */
type Rows = { get(pk: string, sk: string): Row | undefined; find(predicate: (item: Row) => boolean): Row[] };

/** The tasks a member counter holds a slot for, in either form, sorted. */
export function heldTasks(db: Rows, member: Key): string[] {
  const ids = new Set<string>();
  const tasks = db.get(member.pk, member.sk)?.["tasks"];
  if (tasks instanceof Set) for (const id of tasks) ids.add(String(id));
  for (const item of db.find((candidate) => candidate["pk"] === member.pk && candidate["entityType"] === "DEVELOPER_LIMIT_TASK" && candidate["memberSk"] === member.sk)) ids.add(String(item["taskId"]));
  return [...ids].sort();
}

/** What a member counter shows a test: its count and the tasks it holds (either form). */
export function counterView(db: FakeDynamoDb, member: Key): { count: unknown; tasks: string[] } {
  return { count: db.get(member.pk, member.sk)?.["count"], tasks: heldTasks(db, member) };
}

/** Takes a task out of a member counter in both forms, as a release would, without touching the count. */
export function dropHeldTask(db: FakeDynamoDb, member: Key, taskId: string): void {
  db.delete(member.pk, `TASK#${taskId}`);
  const counter = db.get(member.pk, member.sk);
  const tasks = counter?.["tasks"];
  if (counter !== undefined && tasks instanceof Set) {
    const rest = new Set([...tasks].filter((id) => id !== taskId));
    const without = { ...counter };
    delete without["tasks"];
    db.set(rest.size === 0 ? without : { ...without, tasks: rest });
  }
}

/** Makes a member counter hold exactly these tasks as markers (the form this code writes), dropping any other marker and the old set. */
export function setHeldTasks(db: FakeDynamoDb, member: Key, taskIds: readonly string[], chargedAt = "2026-11-11T00:00:00.000Z"): void {
  for (const item of db.find((candidate) => candidate["pk"] === member.pk && candidate["entityType"] === "DEVELOPER_LIMIT_TASK" && candidate["memberSk"] === member.sk)) db.delete(String(item["pk"]), String(item["sk"]));
  const counter = db.get(member.pk, member.sk);
  if (counter !== undefined) {
    const without = { ...counter };
    delete without["tasks"];
    db.set(without);
  }
  for (const taskId of taskIds) db.set({ pk: member.pk, sk: `TASK#${taskId}`, entityType: "DEVELOPER_LIMIT_TASK", taskId, memberSk: member.sk, chargedAt });
}
