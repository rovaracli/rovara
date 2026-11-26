// STRICT-READERS-KNOWN-FIELDS: Cloud's destructive-confirmation readers (project archive and restore, preview and outcome) and the org service status stay EXACT readers
// (DEC 254zzz582: no forward reading for a screen that confirms a destructive action), and now list the fields Code's schemas already carry:
//   expectedProjectIncarnation  (Code packages/contracts/src/reviewed-project-{archive,restore}.ts line 12: `config.optional()`, a positive safe integer, sent only when the project's
//                                stored identity has an incarnation; also inside `current` of the outcome), and
//   teamRecord                  (Code packages/contracts/src/app-service-status.ts line 10: `{ status: ok|warn|unknown, detail: string max 300 }` strict, optional).
// Per reader: the answer with the field parses, without it parses, a wrong type is refused, and an extra unknown field is still refused. The `...ReaderSchema` of each is the strict schema with
// `.strip()` at the TOP level only (it drops envelope fields such as requestId; the controller keeps that top level forward-tolerant, T2 design); every nested object stays strict.
import { describe, expect, it } from "vitest";
import type * as zod from "zod";
import {
  OrgServiceStatusReaderSchema, OrgServiceStatusSchema,
  ReviewedProjectArchiveOutcomeReaderSchema, ReviewedProjectArchiveOutcomeSchema, ReviewedProjectArchivePreviewReaderSchema, ReviewedProjectArchivePreviewSchema,
  ReviewedProjectRestoreOutcomeReaderSchema, ReviewedProjectRestoreOutcomeSchema, ReviewedProjectRestorePreviewReaderSchema, ReviewedProjectRestorePreviewSchema,
} from "../../packages/contracts/src/web.js";

const orgId = "org_abcdefghij0123456789", at = "2026-11-26T04:00:00.000Z";
type Row = Record<string, unknown>;
const archivePreview = (extra: Row = {}): Row => ({ orgId, project: "web-app", status: "active", expectedRevision: 0, expectedProjectRevision: 4, checkedAt: at, access: { actions: ["archive"] }, impact: { stopsNewWork: true, stopsRunningTasksAtNextStep: true, linkedSlackChannels: 2, slackChannelsStayLinked: true, deletesNothing: true }, ...extra });
const restorePreview = (extra: Row = {}): Row => ({ orgId, project: "web-app", status: "archived", expectedRevision: 1, expectedProjectRevision: 4, checkedAt: at, prerequisites: "not_required", access: { actions: ["restore"] }, impact: { allowsNewWork: true, linkedSlackChannels: 2 }, ...extra });
const archiveOutcome = (current: Row, extra: Row = {}): Row => ({ receipt: { project: "web-app", status: "archived", revision: 1, projectRevision: 4, archivedAt: at, egressReconciliation: "pending" }, replayed: false, current, effects: { egress: "not_attempted", archiveHook: "not_configured" }, ...extra });
const restoreOutcome = (current: Row, extra: Row = {}): Row => ({ receipt: { project: "web-app", status: "active", revision: 2, projectRevision: 4, restoredAt: at, egressReconciliation: "pending" }, replayed: false, current, effects: { egress: "not_attempted" }, ...extra });
const serviceStatus = (extra: Row = {}): Row => ({ orgId, source: "stored_runtime_qualification", checkedAt: at, configured: false, checks: [{ kind: "web", state: "unknown", observation: "unknown", reason: "not_configured" }, { kind: "api", state: "unknown", observation: "unknown", reason: "not_configured" }], ...extra });

interface Case { readonly name: string; readonly reader: zod.ZodType; readonly strictSchema: zod.ZodType; readonly build: (field: Row) => Row; readonly read: (data: unknown) => unknown; readonly nested: ReadonlyArray<readonly [string, (extra: Row) => Row]> }
const incarnationOf = (data: unknown) => (data as { expectedProjectIncarnation?: unknown }).expectedProjectIncarnation;
const currentIncarnationOf = (data: unknown) => incarnationOf((data as { current: unknown }).current);
const incarnationCases: Case[] = [
  { name: "archive preview", reader: ReviewedProjectArchivePreviewReaderSchema, strictSchema: ReviewedProjectArchivePreviewSchema, build: (f) => archivePreview(f), read: incarnationOf,
    nested: [["access", (e) => archivePreview({ access: { actions: ["archive"], ...e } })], ["impact", (e) => archivePreview({ impact: { ...(archivePreview().impact as Row), ...e } })]] },
  { name: "archive outcome (current)", reader: ReviewedProjectArchiveOutcomeReaderSchema, strictSchema: ReviewedProjectArchiveOutcomeSchema, build: (f) => archiveOutcome(archivePreview(f)), read: currentIncarnationOf,
    nested: [["current", (e) => archiveOutcome(archivePreview(e))], ["receipt", (e) => archiveOutcome(archivePreview(), { receipt: { ...(archiveOutcome({}).receipt as Row), ...e } })], ["effects", (e) => archiveOutcome(archivePreview(), { effects: { egress: "pending", archiveHook: "pending", ...e } })]] },
  { name: "restore preview", reader: ReviewedProjectRestorePreviewReaderSchema, strictSchema: ReviewedProjectRestorePreviewSchema, build: (f) => restorePreview(f), read: incarnationOf,
    nested: [["access", (e) => restorePreview({ access: { actions: ["restore"], ...e } })], ["impact", (e) => restorePreview({ impact: { ...(restorePreview().impact as Row), ...e } })]] },
  { name: "restore outcome (current)", reader: ReviewedProjectRestoreOutcomeReaderSchema, strictSchema: ReviewedProjectRestoreOutcomeSchema, build: (f) => restoreOutcome(restorePreview(f)), read: currentIncarnationOf,
    nested: [["current", (e) => restoreOutcome(restorePreview(e))], ["receipt", (e) => restoreOutcome(restorePreview(), { receipt: { ...(restoreOutcome({}).receipt as Row), ...e } })], ["effects", (e) => restoreOutcome(restorePreview(), { effects: { egress: "pending", ...e } })]] },
];

describe.each(incarnationCases)("$name reader: expectedProjectIncarnation", (c) => {
  it("parses an answer with the field and keeps its value", () => {
    for (const value of [1, 7, Number.MAX_SAFE_INTEGER]) {
      const parsed = c.reader.safeParse(c.build({ expectedProjectIncarnation: value }));
      expect(parsed.success, String(value)).toBe(true);
      expect(c.read(parsed.data)).toBe(value);
      expect(c.strictSchema.safeParse(c.build({ expectedProjectIncarnation: value })).success).toBe(true);
    }
  });
  it("parses an answer without the field (a project from before incarnations, and today's Code answers)", () => {
    const parsed = c.reader.safeParse(c.build({}));
    expect(parsed.success).toBe(true);
    expect(c.read(parsed.data)).toBeUndefined();
  });
  it("refuses a wrong type or an out-of-range value", () => {
    for (const bad of ["7", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, true, [7], { n: 7 }]) {
      expect(c.reader.safeParse(c.build({ expectedProjectIncarnation: bad })).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("still refuses an extra unknown field in every nested object, and in the strict schema at the top", () => {
    for (const [where, make] of c.nested) {
      // The known field belongs to the preview (`current` of an outcome) only: inside access, impact, receipt or effects it is an unknown field.
      expect(c.reader.safeParse(make({ expectedProjectIncarnation: 3 })).success, `${where} with the known field`).toBe(where === "current");
      expect(c.reader.safeParse(make({ futureNote: "x" })).success, `${where} unknown field`).toBe(false);
    }
    expect(c.strictSchema.safeParse({ ...c.build({ expectedProjectIncarnation: 3 }), futureNote: "x" }).success).toBe(false);
    // The reader's `.strip()` is top level only and is what drops an envelope field (requestId); it is the existing behaviour and is not changed here.
    expect(c.reader.safeParse({ ...c.build({}), requestId: "r" }).success).toBe(true);
  });
});

describe("OrgServiceStatus reader: teamRecord", () => {
  const record = { status: "warn", detail: "The team record last synced two days ago." };
  it("parses an answer with the field and keeps it, for every status Code names", () => {
    for (const status of ["ok", "warn", "unknown"]) {
      const parsed = OrgServiceStatusReaderSchema.safeParse(serviceStatus({ teamRecord: { status, detail: "x" } }));
      expect(parsed.success, status).toBe(true);
      expect((parsed.data as { teamRecord?: unknown }).teamRecord).toEqual({ status, detail: "x" });
    }
    expect(OrgServiceStatusReaderSchema.safeParse(serviceStatus({ teamRecord: { status: "ok", detail: "x".repeat(300) } })).success).toBe(true);
    expect(OrgServiceStatusSchema.safeParse(serviceStatus({ teamRecord: record })).success).toBe(true);
  });
  it("parses an answer without it", () => {
    const parsed = OrgServiceStatusReaderSchema.safeParse(serviceStatus());
    expect(parsed.success).toBe(true);
    expect((parsed.data as { teamRecord?: unknown }).teamRecord).toBeUndefined();
  });
  it("refuses a wrong type, a status Code does not name, a missing part and a detail over 300", () => {
    for (const bad of ["ok", null, 1, [], {}, { status: "ok" }, { detail: "x" }, { status: "fine", detail: "x" }, { status: 1, detail: "x" }, { status: "ok", detail: 5 }, { status: "ok", detail: null }, { status: "ok", detail: "x".repeat(301) }]) {
      expect(OrgServiceStatusReaderSchema.safeParse(serviceStatus({ teamRecord: bad })).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("still refuses an extra unknown field inside teamRecord, inside a check, and at the top of the strict schema", () => {
    expect(OrgServiceStatusReaderSchema.safeParse(serviceStatus({ teamRecord: { ...record, futureNote: "x" } })).success).toBe(false);
    const withCheckExtra = serviceStatus(); (withCheckExtra.checks as Row[])[0] = { ...(withCheckExtra.checks as Row[])[0], futureNote: "x" };
    expect(OrgServiceStatusReaderSchema.safeParse(withCheckExtra).success).toBe(false);
    expect(OrgServiceStatusSchema.safeParse(serviceStatus({ teamRecord: record, futureNote: "x" })).success).toBe(false);
  });
});
