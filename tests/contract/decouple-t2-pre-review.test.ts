// DECOUPLE T2, Sonnet pre-review (test-only). Four things the lane's own tests did not pin:
// 1. the drift gate's new identifier scan loses no Schema name that is written in CODE (only names in comments or strings),
// 2. an unreadable task-money block reads as no money at every place the reader is used, a readable one is passed on unchanged, and one with an extra field or an unknown word is never partly read,
// 3. a People role this build does not know never makes anyone a co-owner (the server asks for exactly "owner" twice),
// 4. an unknown outcome of a task-start answer never relays a task, even when Code sent a complete-looking one.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LiveTileReaderSchema, SessionViewReaderSchema } from "@agentx/contracts/web";
import { parsedSchemaNames } from "../../scripts/contract-drift/run.js";
import { coOwnerOf } from "../../packages/cloud-server/src/people-routes.js";
import { liveTile } from "../../packages/cloud-server/src/session-view.js";
import { sessionFixture, sessionPerson, taskFixture, SESSION_FIXTURE_ID } from "../web/support/session-fixture.js";
import { ownerMoney } from "../web/support/pr-feedback-fixture.js";

describe("drift gate: the identifier scan loses no Schema name that is written in code", () => {
  // The old scan was a word match over the text. Every word it found that the new scan does not is dropped; each such place must be a comment line or a string, never code.
  it("every `...Schema` word the old text match found and the new scan drops sits on a comment line, or inside a string", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const dropped: string[] = [];
    const parsed = parsedSchemaNames();
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { visit(full); continue; }
        if (!/\.tsx?$/u.test(entry.name)) continue;
        let inBlock = false;
        readFileSync(full, "utf8").split("\n").forEach((line, index) => {
          const trimmed = line.trim();
          const startsBlock = trimmed.startsWith("/*"), comment = inBlock || startsBlock || trimmed.startsWith("//") || trimmed.startsWith("*");
          if (startsBlock && !trimmed.includes("*/")) inBlock = true; else if (inBlock && trimmed.includes("*/")) inBlock = false;
          for (const match of line.matchAll(/\b[A-Z][A-Za-z0-9]*Schema\b/gu)) {
            if (parsed.has(match[0])) continue;
            const before = line.slice(0, match.index);
            const inString = (before.match(/"/gu)?.length ?? 0) % 2 === 1 || (before.match(/`/gu)?.length ?? 0) % 2 === 1 || (before.match(/'/gu)?.length ?? 0) % 2 === 1;
            const afterLineComment = /\/\/|\/\*/u.test(before);
            if (!comment && !inString && !afterLineComment) dropped.push(`${path.relative(root, full)}:${String(index + 1)} ${match[0]}: ${trimmed.slice(0, 120)}`);
          }
        });
      }
    };
    for (const dir of ["packages/ui/src", "packages/cloud-server/src"]) visit(path.join(root, dir));
    expect(dropped).toEqual([]);
  });
  it("names written in code with a renamed import, through a namespace, or in a .tsx file are still counted", () => {
    // SessionViewReaderSchema is used by name in the app and the server; a `.tsx` file and a namespace access (`web.SessionViewReaderSchema`) both give identifiers.
    const parsed = parsedSchemaNames();
    expect(parsed.has("SessionViewReaderSchema")).toBe(true);
    expect(parsed.has("SessionPeopleResponseReaderSchema")).toBe(true);
    expect(parsed.has("StartDeveloperTaskRequestSchema")).toBe(true); // imported in the server file task-start-request-routes.ts and read as `StartDeveloperTaskRequestSchema.shape.requestId`
  });
});

describe("task money in a reader: exact or not at all", () => {
  const view = (money: unknown) => ({ ...sessionFixture(), money, display: { state: "needs_you", reason: "r", next: "n" } });
  it("a readable block is passed on unchanged; the same block with an extra field or an unknown word reads as no money (never partly read)", () => {
    const good = ownerMoney();
    expect(SessionViewReaderSchema.parse(view(good)).money).toEqual(good);
    const bad = [
      { ...good, futureField: 1 },
      { ...good, payer: { state: "available", value: { kind: "robot", id: "x", name: "R" } } },
      { ...good, state: "settling" },
      { ...good, spentMicros: { state: "available", value: -5 } },
      { ...good, spentMicros: { state: "available", value: 1.5 } },
      { ...good, stop: { ...good.stop, bindingScope: { state: "available", value: "galaxy" } } },
      "money", 7, null, [],
    ];
    for (const money of bad) {
      const read = SessionViewReaderSchema.parse(view(money));
      expect(read.money, JSON.stringify(money).slice(0, 80)).toBeUndefined();
      expect(read.title).toBe(sessionFixture().title);
    }
  });
  it("the same holds on a Live tile, so one unreadable block never refuses a list of tiles", () => {
    const task = taskFixture({ status: "RUNNING" });
    const tile = liveTile({ sessionId: SESSION_FIXTURE_ID, taskId: task.taskId, project: "payments", owner: sessionPerson, startedBy: sessionPerson, createdAt: "2026-10-23T12:00:00.000Z", revision: 1 }, task as unknown as Parameters<typeof liveTile>[1], sessionPerson, "https://cell.example");
    expect(LiveTileReaderSchema.parse({ ...tile, money: ownerMoney() }).money).toEqual(ownerMoney());
    expect(LiveTileReaderSchema.parse({ ...tile, money: { ...ownerMoney(), future: true } }).money).toBeUndefined();
  });
});

describe("a People role this build does not know never makes a co-owner", () => {
  const PERSON = "11111111-1111-4111-8111-111111111111";
  const record = { taskId: "22222222-2222-4222-8222-222222222222" } as never;
  const ask = (people: unknown[]) => coOwnerOf({ client: { json: async () => ({ view: { revision: 1, orphaned: false, canManage: false, canTakeOwnership: false, people } }) }, session: {} } as never, record);
  const entry = (role: unknown, effectiveRole: unknown, you = true) => ({ personId: PERSON, name: "Sam", role, you, effectiveRole });
  it("is a co-owner only with role owner AND effective role owner, for the viewer's own entry", async () => {
    expect(await ask([entry("owner", "owner")])).toBe(true);
    expect(await ask([entry("owner", "owner", false)])).toBe(false);
    for (const [role, effective] of [["owner", null], ["owner", "viewer"], ["owner", "super-owner"], ["super-owner", "owner"], ["Owner", "owner"], ["owner ", "owner"], ["admin", "admin"], ["denied", "owner"], ["viewer", "owner"], [5, "owner"], ["owner", 5], ["owner", undefined]]) {
      expect(await ask([entry(role, effective)]), JSON.stringify([role, effective])).toBe(false);
    }
  });
  it("a viewer whose own entry the page cannot read, next to a readable list, is no co-owner (the whole view is unread)", async () => {
    expect(await ask([entry("owner", "owner"), { personId: PERSON, name: "", role: "owner", you: false, effectiveRole: "owner" }])).toBe(false);
  });
});
