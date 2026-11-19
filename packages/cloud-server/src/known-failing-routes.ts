// Cloud forwards the website session; Code owns all role, evidence, mark and audit decisions.
import type { Route } from "./routes.js";
const path = (project: string) => `/v1/app/projects/${encodeURIComponent(project)}/known-failing`;
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("unreadable known-failing response");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error("unreadable known-failing response");
  return value;
}
function when(value: unknown): string { const result = text(value, 40); if (!Number.isFinite(Date.parse(result))) throw new Error("unreadable mark time"); return result; }
function positive(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("unreadable mark version"); return value as number; }
export function knownFailingAnswer(value: unknown, done: boolean) {
  const row = record(value);
  if (!Array.isArray(row["marks"]) || row["marks"].length > 500 || (done && row["status"] !== "done")) throw new Error("unreadable known-failing response");
  const max = positive(row["max"]);
  const marks = row["marks"].map((value: unknown) => {
    const mark = record(value);
    if (typeof mark["markedByYou"] !== "boolean") throw new Error("unreadable known-failing response");
    return { name: text(mark["name"], 500), checkId: text(mark["checkId"], 64), markedBy: text(mark["markedBy"], 200), markedByName: text(mark["markedByName"], 200), markedAt: when(mark["markedAt"]), epoch: positive(mark["epoch"]), markedByYou: mark["markedByYou"] };
  });
  return { ...(done ? { status: "done" as const } : {}), max, marks };
}
export const KNOWN_FAILING_ROUTES: readonly Route[] = (["GET", "POST"] as const).map((method): Route => ({
  method, path: /^\/projects\/([^/]+)\/known-failing$/u,
  async answer({ client, session, params, body }) {
    const project = params[0];
    if (project === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(project)) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Project not found." } } };
    let undo: Record<string, unknown> | undefined;
    if (method === "POST") {
      try {
        const input = record(body);
        if (Object.keys(input).sort().join(",") !== "action,checkId,epoch,markedAt,markedBy,name,requestId" || input["action"] !== "undo" || !/^[A-Za-z0-9_-]{8,64}$/u.test(text(input["requestId"], 64))) throw new Error("invalid undo");
        undo = { action: "undo", requestId: input["requestId"], name: text(input["name"], 500), checkId: text(input["checkId"], 64), markedBy: text(input["markedBy"], 200), markedAt: when(input["markedAt"]), epoch: positive(input["epoch"]) };
      } catch { return { status: 400, body: { error: { code: "CONFIG_INVALID", message: "Invalid Undo request." } } }; }
    }
    const response = await client.json<unknown>(session, path(project), method === "POST" ? { method, body: undo } : undefined);
    try { return { status: 200, body: knownFailingAnswer(response, method === "POST") }; }
    catch { return { status: 502, body: { error: { code: "CODE_UNREADABLE", message: "The known-failing marks could not be read." } } }; }
  },
}));
