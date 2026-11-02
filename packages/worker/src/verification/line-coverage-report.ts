// Proof and evidence (EV-2): the one place a Go cover profile or a JaCoCo XML report is read from disk. The readers in `changed-coverage.ts` take text and have no file access, no freshness rule and no containment of
// their own; a caller that has a path from a check's command line MUST come through here, so the file goes through `readContainedReport` like every other report (it stays inside the workspace, is a plain file, is
// opened without following links, is within a size cap, and was written in this round: modification AND change time in the round and neither in the future). A failure is a fixed code, never a message.
//
// What the file proves is the limit every report has: it is what the project's tooling wrote, and code that runs in the round (a test, a build plugin the agent changed) can write it too.
import { GO_COVER_PROFILE_MAX_BYTES, JACOCO_XML_MAX_BYTES, parseLineCoverage, type LineCoverage, type LineCoverageFormat, type LineCoverageOptions } from "./changed-coverage.js";
import { readContainedReport, type ReportFileFailure } from "./report-file.js";

export type LineCoverageSkip = ReportFileFailure | "unparsable";
export interface ReadLineCoverageInput {
  /** The workspace root; the report must stay inside it. */
  root: string;
  /** The check's directory under the root, and the report's path as the check's command line names it. */
  cwd: string;
  argument: string;
  /** When the check round began: a report older than this was not written by this round's checks. Without it nothing is read. */
  notBeforeMs: number | undefined;
  /** What the readers need to place a report's files in the repository (Go modules, Java source roots). */
  options: LineCoverageOptions;
  nowMs?: number;
}

/** Reads a Go cover profile or a JaCoCo XML report the check wrote in this round, or says why not. Never throws. */
export async function readLineCoverageReport(input: ReadLineCoverageInput): Promise<{ ok: true; format: LineCoverageFormat; coverage: LineCoverage; path: string } | { ok: false; reason: LineCoverageSkip }> {
  try {
    const read = await readContainedReport({ root: input.root, cwd: input.cwd, argument: input.argument, maxBytes: Math.max(GO_COVER_PROFILE_MAX_BYTES, JACOCO_XML_MAX_BYTES), notBeforeMs: input.notBeforeMs, ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }) });
    if (!read.ok) return read;
    const text = read.bytes.toString("utf8");
    const parsed = parseLineCoverage(text, input.options);
    if (parsed === undefined) return { ok: false, reason: "unparsable" };
    // The Go cap is lower than the JaCoCo one; the larger cap was only the read's.
    if (parsed.format === "go" && read.bytes.length > GO_COVER_PROFILE_MAX_BYTES) return { ok: false, reason: "too_large" };
    return { ok: true, format: parsed.format, coverage: parsed.coverage, path: read.path };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}
