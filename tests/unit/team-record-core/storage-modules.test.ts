// TR-E3 G2: a raw DynamoDB read of the TeamRecord table (Get, Query, BatchGet or Scan) lives only in a listed storage module. The read-path test (`tests/unit/lessons/read-paths.test.ts`) follows calls
// of the store's own read helpers; a new file that reads the table directly would slip past it, so it fails here until it is either moved behind the store or listed with its reason.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../..");
const SRC = join(ROOT, "packages/broker/src");
const RAW_READ = /\b(?:GetCommand|QueryCommand|BatchGetCommand|ScanCommand)\b/u;
/** Tokens that tie a file outside `team-record/` to the TeamRecord table (its key builders and its table type). */
const RECORD_TABLE = /\b(?:teamRecordPk|TEAM_RECORD_GSI\d|TeamRecordTable|teamRecordOrgDirectoryKey|recordSourceKey|recordEventKey|recordFactKey)\b/u;

/** Every file under `team-record/` that reads the table directly, with what it reads. Adding a file here is a review decision. */
const RECORD_STORAGE_MODULES: Record<string, string> = {
  "team-record/store.ts": "the store: rows, facts, source rows, index reads",
  "team-record/source-store.ts": "source rows, their changes, requests and revision markers",
  "team-record/access.ts": "access records and unit headers",
  "team-record/item-head.ts": "item heads and sticky place closes",
  "team-record/scope-work.ts": "the delete and audience work queue",
  "team-record/delete-worker.ts": "the delete worker's own queue and head reads",
  "team-record/erase.ts": "erase progress, sweep items and markers",
  "team-record/erased.ts": "erased-person markers",
  "team-record/purge.ts": "reads the rows and links a purge removes",
  "team-record/hot-source.ts": "the hot archive source and deleted-at-source marks",
  "team-record/text-expiry.ts": "the raw-text expiry walk",
  "team-record/reembed.ts": "the re-embed job: reads the text-due index for rows that need a vector",
  "team-record/mode.ts": "the capture mode and its lock",
  "lessons/model-setting.ts": "the company's chosen lessons model (an org-scoped key; a model id and a time, no person (the setter is only in the audit ledger); nothing erasable), read as stored so the setting is written conditionally on exactly that value (lessons-prod-1b)",
  "lessons/pause.ts": "the current lessons-paused reason per project or company (org-scoped keys; a fixed code, a start time and a failure count; nothing erasable) (lessons-prod-1b)",
  "team-record/learning-mode-write.ts": "the learning mode and its lock, read as stored so the mode's writer can write conditionally on exactly that value (UX-4b)",
  "team-record/prior-edits.ts": "marks of edits the tap never stored",
  "team-record/capture-indexes.ts": "the once-claims, push index and merge index of the human-edit read",
  "team-record/identity-links.ts": "identity links of people",
  "team-record/tracker-directory.ts": "the tracker people directory",
  "team-record/tracker-autolink.ts": "automatic tracker links",
  "team-record/runtime.ts": "the runtime's own job state, org directory and project sweeps",
};
/** Files outside `team-record/` that read the TeamRecord table because lessons and approvals are kept in it. */
const OUTSIDE_STORAGE_MODULES: Record<string, string> = {
  "agents/approvals-store.ts": "approval items kept in the record partition",
  "lessons/dynamo-store.ts": "the lessons store",
  "lessons/dynamo-settings.ts": "the learning settings",
  "lessons/delivery-wiring.ts": "lesson delivery reads",
  "org/test-environment.ts": "the test-environment row",
  "lessons/task-outcome-rows.ts": "the nightly re-reflection's look at one project's `rovara.reverted_by` link rows of the last 26 h (a record query by time, never a scan; ids only; erased, tombstoned and expired rows are skipped by `eventFromItem`) (lessons-prod-2)",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : name.endsWith(".ts") && !name.endsWith(".d.ts") ? [path] : [];
  });
}

/** The files that read the record table directly, relative to the broker's src. */
function rawRecordReaders(files: ReadonlyArray<{ path: string; text: string }>): string[] {
  return files
    .filter(({ path, text }) => RAW_READ.test(text) && (path.startsWith("team-record/") || RECORD_TABLE.test(text)))
    .map(({ path }) => path)
    .sort();
}

describe("TR-E3 G2: raw reads of the TeamRecord table stay in the storage modules", () => {
  const files = sourceFiles(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, "utf8") }));
  const readers = rawRecordReaders(files);

  it("every file that reads the table directly is listed", () => {
    const listed = new Set([...Object.keys(RECORD_STORAGE_MODULES), ...Object.keys(OUTSIDE_STORAGE_MODULES)]);
    expect(readers.filter((path) => !listed.has(path))).toEqual([]);
  });

  it("the lists name only files that still read the table (a stale entry fails)", () => {
    expect([...Object.keys(RECORD_STORAGE_MODULES), ...Object.keys(OUTSIDE_STORAGE_MODULES)].filter((path) => !readers.includes(path))).toEqual([]);
  });

  it("the check can fail: a planted reader is caught, and a file with no raw read is not", () => {
    const planted = rawRecordReaders([
      { path: "agents/new-thing.ts", text: 'import { QueryCommand } from "@aws-sdk/lib-dynamodb"; const pk = teamRecordPk(org);' },
      { path: "agents/other.ts", text: 'import { QueryCommand } from "@aws-sdk/lib-dynamodb"; // some other table' },
      { path: "team-record/new-reader.ts", text: 'await table.documentClient.send(new GetCommand({}));' },
      { path: "team-record/uses-store.ts", text: 'import { bySource } from "./store.js";' },
    ]);
    expect(planted).toEqual(["agents/new-thing.ts", "team-record/new-reader.ts"]);
  });
});
