// Contract drift, the runner: Cloud's side of the comparison, the pinned snapshot of Code's side, the baseline of accepted drift, and the refresh from a Code checkout. Used by
// scripts/contract-drift.ts and tests/contract/contract-drift.test.ts. Rules and the refresh: scripts/contract-drift.ts.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { makeTemporaryNodeModules } from "./code-workspaces.js";
import { compareDocuments, driftKey, isRequestSchemaName, type Drift, type DriftReport, type SchemaDocument } from "./compare.js";
import { extractSchemas, type Extracted, type ZodLike } from "./extract.js";

export const CLOUD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SNAPSHOT_PATH = path.join(CLOUD_ROOT, "tests/fixtures/code-contract-snapshot/code-contracts.json");
export const BASELINE_PATH = path.join(CLOUD_ROOT, "tests/fixtures/code-contract-snapshot/accepted-drift.json");

/** Where the snapshot came from. */
export interface SnapshotSource { readonly repository: string; readonly ref: string; readonly sha: string; readonly zod: string }
export interface Snapshot extends SchemaDocument {
  readonly format: 1;
  readonly source: SnapshotSource;
  /** The Cloud contract files that decide what the browser parses (packages/contracts/web-safe-files.json); each is compared with the file of the same name in Code. */
  readonly files: readonly string[];
  /** Cloud files Code does not have (Cloud-only screens). */
  readonly missingFiles: readonly string[];
  /** The count of forward readers left out. */
  readonly skippedReaders: number;
}

/** A drift Cloud knowingly lives with, keyed by `driftKey`, with the reason. */
export interface AcceptedDrift { readonly key: string; readonly why: string }
/** The accepted-drift file: one reason and the keys it covers. */
export interface AcceptedGroup { readonly why: string; readonly keys: readonly string[] }

export function webSafeFiles(): string[] {
  return (JSON.parse(readFileSync(path.join(CLOUD_ROOT, "packages/contracts/web-safe-files.json"), "utf8")) as string[]).filter((file) => /\/src\/[^/]+\.ts$/u.test(file) && !/\/web(?:-init|-hash)?\.ts$/u.test(file));
}

export async function extractCloud(zod: ZodLike): Promise<Extracted> {
  return extractSchemas({ root: CLOUD_ROOT, files: webSafeFiles(), zod, io: "input" });
}

export function readSnapshot(file = SNAPSHOT_PATH): Snapshot {
  return JSON.parse(readFileSync(file, "utf8")) as Snapshot;
}

export function readAccepted(file = BASELINE_PATH): AcceptedDrift[] {
  const groups = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as AcceptedGroup[]) : [];
  return groups.flatMap((group) => group.keys.map((key) => ({ key, why: group.why })));
}

export function writeAccepted(groups: readonly AcceptedGroup[], file = BASELINE_PATH): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(groups, null, 2)}\n`);
}

export interface CheckResult {
  readonly report: DriftReport;
  /** Drifts not in the accepted list: these fail the check. */
  readonly unaccepted: readonly Drift[];
  /** Accepted entries that no longer match anything (Cloud was fixed, or Code reverted): reported, never a failure, so a fix can land before or after the entry is removed. */
  readonly staleAccepted: readonly AcceptedDrift[];
}

/**
 * The `...Schema` identifiers a source file CODE uses. A name in a comment or a string is not a parser: before T2 (DECOUPLE, #1516) a comment that said "(SessionViewSchema, ...)" in
 * packages/cloud-server/src/session-view.ts made the strict `SessionViewSchema` count as read by Cloud, so Code's additive `you.chargedTo` failed the deployed-drift gate although nothing in Cloud
 * parses a session view with that schema (the web app reads it with the forward reader).
 */
function schemaIdentifiers(file: string, source: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && /^[A-Z][A-Za-z0-9]*Schema$/u.test(node.text)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
  return found;
}

/**
 * Hand-written readers that stay EXACT (pre-review S4): access, destructive-confirmation, money and plan-review answers Cloud reads with a strict reader that is not built by forwardReader (DECOUPLE-T2-DONE.md gives each reason).
 * Code is compared with the strict schema each one is read with, though code writes only the `...ReaderSchema` name: `XReaderSchema` here means `XSchema` is compared.
 */
export const HAND_WRITTEN_EXACT_READERS: readonly string[] = [
  "DecisionOutcomeReaderSchema", "JiraOrgAdminResultReaderSchema", "LoadedKnowledgeResponseReaderSchema", "LoadedKnowledgeTextReaderSchema", "ModelSelectionPolicyResponseReaderSchema", "OrgServiceStatusReaderSchema",
  "OrgSlackWorkspaceEvidenceResponseReaderSchema", "ProjectAllowedWebsitesProposalReaderSchema", "ProjectAllowedWebsitesResultReaderSchema", "ProjectAllowedWebsitesReviewReaderSchema", "ProjectSlackDecisionReaderSchema",
  "ProjectSlackInventoryReaderSchema", "ProjectSlackProposalReaderSchema", "ProjectSlackReceiptReaderSchema", "ProjectSlackTargetReaderSchema", "ProjectWorkingBranchContextReaderSchema", "ProjectWorkingBranchPageReaderSchema",
  "ProjectWorkingBranchPreviewReaderSchema", "ProjectWorkingBranchSaveResultReaderSchema", "ReviewedProjectArchiveOutcomeReaderSchema", "ReviewedProjectArchivePreviewReaderSchema", "ReviewedProjectRestoreOutcomeReaderSchema",
  "ReviewedProjectRestorePreviewReaderSchema", "TrackerPeopleReaderSchema", "TrackerPeopleResultReaderSchema",
];

/**
 * Schemas the server or the app checks Code's answer against BY HAND, field by field (it refuses an answer with a field or word it does not list), whose only mention in code is the comment that says what it mirrors (pre-review S5). Before
 * the identifier scan these were compared by accident (the comment counted); they stay compared on purpose, so a Code change to one of them still shows in the gate while the hand-written check would refuse it. Not here, on purpose: SessionViewSchema,
 * SessionMessageSchema, WorkflowSnapshotShapeSchema and ProjectOverviewSchema (Cloud reads those with forward readers: the #1516 failure was a comment counting them), LiveTileSchema, SessionEventSchema and SessionShareSchema (Cloud builds those itself), request bodies, and local names.
 */
export const MIRRORED_SCHEMA_NAMES: readonly string[] = [
  "AppMeResponseSchema", "AppProjectSummarySchema", "DeveloperTaskEventSchema", "HowWeWorkViewSchema", "SavedEnvPanelSchema", "WorkflowFeedbackReviewRefSchema", "WorkflowStageSchema",
];

/**
 * Comment-only mirrors that the gate CANNOT compare today: their contract file is not in packages/contracts/web-safe-files.json, so Code's snapshot has no schema of that name to compare (listed so the loss is explicit, not silent; the test
 * pins that each is absent from the snapshot and tells the day one becomes comparable, when it moves to MIRRORED_SCHEMA_NAMES). ProjectOverviewSchema is not here: Cloud reads it with a forward reader (the #1516 class).
 */
export const MIRRORED_NOT_COMPARABLE: readonly string[] = [
  "AdminBudgetSettingsSchema", "AgentDirectoryResponseSchema", "AppNavSchema", "CompanyEngineModelViewSchema", "CompanyLearningModelViewSchema", "DeveloperTaskListDetailSchema", "DeveloperTaskListRoundSchema", "FeatureIdSchema",
  "MemberRemovalPreviewSchema", "TaskPeopleChangeResultSchema", "UpkeepSpendSchema",
];

/**
 * The schemas Cloud's own code reads an answer with: every `...Schema` name written in the web app (packages/ui/src) or the server (packages/cloud-server/src). A drift in a schema nothing
 * here names cannot refuse an answer today, and the day something starts to use it the name shows up here and the drift with it.
 */
export function parsedSchemaNames(): Set<string> {
  const names = new Set<string>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.tsx?$/u.test(entry.name)) for (const name of schemaIdentifiers(full, readFileSync(full, "utf8"))) names.add(name);
    }
  };
  for (const dir of ["packages/ui/src", "packages/cloud-server/src"]) visit(path.join(CLOUD_ROOT, dir));
  for (const reader of HAND_WRITTEN_EXACT_READERS) if (names.has(reader)) names.add(reader.replace(/ReaderSchema$/u, "Schema"));
  for (const name of MIRRORED_SCHEMA_NAMES) names.add(name);
  return names;
}

export function check(code: SchemaDocument, cloud: SchemaDocument, accepted: readonly AcceptedDrift[], parsed: ReadonlySet<string> = parsedSchemaNames()): CheckResult {
  const report = compareDocuments(code, cloud, (id) => { const name = id.slice(id.indexOf("#") + 1); return parsed.has(name) && !isRequestSchemaName(name); });
  const acceptedKeys = new Set(accepted.map((entry) => entry.key));
  const found = new Set(report.drifts.map(driftKey));
  return { report, unaccepted: report.drifts.filter((drift) => !acceptedKeys.has(driftKey(drift))), staleAccepted: accepted.filter((entry) => !found.has(entry.key)) };
}

/** A Code source to export from: a checkout, or a ref of a repository (read with `git archive`, nothing is checked out or changed there). */
export type CodeSource = { readonly dir: string } | { readonly repo: string; readonly ref: string };

export async function exportCode(source: CodeSource): Promise<Snapshot> {
  let root: string;
  let temporary: string | undefined;
  let ref: string;
  let sha: string;
  if ("dir" in source) {
    root = path.resolve(source.dir);
    ref = "working tree";
    sha = git(root, ["rev-parse", "HEAD"]);
  } else {
    sha = git(source.repo, ["rev-parse", `${source.ref}^{commit}`]);
    ref = source.ref;
    temporary = mkdtempSync(path.join(tmpdir(), "contract-drift-code-"));
    root = temporary;
    // Only the contracts package is read; zod comes from this repository, at the version both repositories pin. The Code workspace packages the contracts import
    // (@preplabsai/rovara-code-api since Code train 42) are exported from the same commit and built into the temporary node_modules (code-workspaces.ts); one that cannot be built throws.
    execFileSync("sh", ["-c", `git -C "$1" archive "$2" packages/contracts | tar -x -C "$3"`, "sh", source.repo, sha, temporary]);
    makeTemporaryNodeModules(temporary, CLOUD_ROOT, source.repo, sha);
  }
  try {
    const zodPackage = createRequire(path.join(root, "package.json")).resolve("zod/package.json");
    const zodVersion = (JSON.parse(readFileSync(zodPackage, "utf8")) as { version: string }).version;
    const zod = (await import(pathToFileURL(path.join(path.dirname(zodPackage), "index.js")).href)) as unknown as ZodLike;
    const files = webSafeFiles();
    const extracted = await extractSchemas({ root, files, zod, io: "output" });
    if (extracted.loadErrors.length > 0) throw new Error(`Code files did not load:\n${extracted.loadErrors.join("\n")}`);
    return {
      format: 1,
      source: { repository: "PrepLabsAI/Rovara", ref, sha, zod: zodVersion },
      files,
      missingFiles: extracted.missingFiles,
      skippedReaders: extracted.skippedReaders.length,
      schemas: extracted.schemas,
      aliases: extracted.aliases,
    };
  } finally {
    if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
  }
}

export function writeSnapshot(snapshot: Snapshot, file = SNAPSHOT_PATH): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(snapshot)}\n`);
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}
