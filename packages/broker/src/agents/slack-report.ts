// Plan 3, Task 22 (R4-2): what an agent's final report may say in Slack. STUB until the implementation commit.
import type { OrgId } from "@agentx/contracts";

export const CHATOPS_PATTERNS: readonly RegExp[] = [];

export type PreparedSlackReport = { kind: "text"; text: string } | { kind: "link_only"; text: string };

export function prepareSlackReport(report: string, options: { orgId: OrgId; taskUrl: string; reportLinkDomains: readonly string[]; extraCommandWords: readonly string[] }): PreparedSlackReport {
  void report; void options;
  throw new Error("not implemented");
}
