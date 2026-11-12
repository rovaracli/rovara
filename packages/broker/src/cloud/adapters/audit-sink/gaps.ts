// Convergence A7 (`cloud/audit-sink`): what the core's audit events cannot say that Cloud's ledger needs. Each is owed upstream (a small additive Code change, then the vendor pin moves); the vendored copy is
// never edited. tests/unit/cloud-audit-sink-gaps.test.ts fails once an entry is past `owedUntil`, so none sits here unseen.

export interface AuditSinkGap {
  id: string;
  /** The core action. */
  action: string;
  owedUntil: string;
  what: string;
  /** What the adapter does meanwhile, so nothing is widened. */
  meanwhile: string;
}

export const AUDIT_SINK_GAPS: readonly AuditSinkGap[] = [
  {
    id: "A7-G1-pull-request-repository-key",
    action: "pull_request.opened",
    owedUntil: "2026-11-25",
    what: "The core's pull_request.opened carries the repository's id in `details.repository` (`web`) and no repository key; pull_request.merge_requested carries the key (`acme/web`). Cloud names a pull request by the opaque id of the key and the number, so one pull request gets two ids. Code should add `repositoryKey` to the opened event (additive, one line in core/build-step/publish.ts).",
    meanwhile: "The id is made from `details.repositoryKey` when the event has it, else `details.repository`; the org's `repository` detail is the same string, so an auditor sees which was used. Once Code sends the key both events agree with no change here.",
  },
];
