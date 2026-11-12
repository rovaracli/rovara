// 0.5.16: what the default-branch check's answer means for the page, one notice per code repository. Pure, so the words and the "is anything blocked" rule are tested without a screen.
import type { BranchCheckResponse, RepositoryBranchCheck } from "@agentx/cloud-contracts/web";

export type BranchNoticeKind = "fine" | "empty" | "missing" | "no_code" | "unchecked" | "continued";
export interface BranchNotice { row: RepositoryBranchCheck; kind: BranchNoticeKind }

/** A repository whose branch has no files and whose person has chosen to go on reads `continued`; one that GitHub could not answer for reads `unchecked`. Only `empty`, `missing` and `no_code` hold anything back. */
export function branchNotices(check: BranchCheckResponse): BranchNotice[] {
 return check.repositories.map((row): BranchNotice => {
  if (row.state === "has_files") return { row, kind: "fine" };
  if (row.state === "unchecked") return { row, kind: "unchecked" };
  return { row, kind: row.continued ? "continued" : row.state };
 });
}
