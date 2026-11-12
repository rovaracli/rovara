// Convergence A6 (`cloud/people`): what Code's IdentityProvider and Approvers ports cannot say that Cloud needs. Each is owed upstream (a Code lane changes the port, then the pin moves); the vendored copy is never edited.
// tests/unit/cloud-people-gaps.test.ts fails once an entry is past `owedUntil`, so none sits here unseen.

export interface PortGap {
  id: string;
  port: "approvers" | "identity";
  owedUntil: string;
  what: string;
  /** What the Cloud adapter does meanwhile, so nothing is widened. */
  meanwhile: string;
}

export const PEOPLE_PORT_GAPS: readonly PortGap[] = [
  {
    id: "A6-G1-window-for-medium-outside",
    port: "approvers",
    owedUntil: "2026-11-25",
    what: "ApprovalRequirement.signIn applies to high-risk approvals and rejections. Cloud's company window (decision 62, U4) applies to MEDIUM approvals from outside places (Slack, comments); high needs the decide-grade step-up instead. The port needs a per-risk or per-place sign-in rule.",
    meanwhile: "signIn is left unset (no extra rule in core) and verify() enforces the window through evaluateApprovalPlace.",
  },
  {
    id: "A6-G2-sole-owner-exception",
    port: "approvers",
    owedUntil: "2026-11-25",
    what: "selfApprovalAllowed is all-or-nothing. Cloud's second-person rule lets a proposer approve their own work only as the company's sole eligible owner after a 24-hour cool-off since the last eligible loss (decideSecondPersonApproval). With minApprovers 2 core counts distinct approvers, so a sole owner can never reach 2.",
    meanwhile: "selfApprovalAllowed is false and minApprovers comes from approversRequired; verify() applies secondPersonOutcome. The sole-owner path stays on Cloud's own routes until the port can say it.",
  },
  {
    id: "A6-G3-step-up-proof-shape",
    port: "approvers",
    owedUntil: "2026-11-25",
    what: "A proof carries one token. Cloud's browser-step-up needs two secrets (the review session and the decide session) and is claimed then spent or given back by the press (withCardDecideGrade); verify() is single-shot and read-only.",
    meanwhile: "The token is '<session id>:<decide cookie>' and verify() checks the decide session read-only (isDecideGradeSession); the caller's commit still claims and spends it.",
  },
  {
    id: "A6-G4-request-binding-content-version",
    port: "approvers",
    owedUntil: "2026-11-25",
    what: "ApprovalRequest has no place for the card's content version, which Cloud's card_decision record binds the decide sign-in to. The step-up issuer can check the record's task (subject id) but not the card version.",
    meanwhile: "The issuer binds the record to request.subject.id; core's own binding to revision and artifactDigest covers the content.",
  },
  {
    id: "A6-G5-merge-from-token",
    port: "approvers",
    owedUntil: "2026-11-25",
    what: "Cloud never merges for a token and merges at once only for a browser session with its CSRF token (authenticateWebRequest). The port has no notion of the press's transport, so a merge gate in core cannot tell a browser press from an api-token one except by method name.",
    meanwhile: "Merges stay on Cloud's routes; the adapter names api-token and browser-session separately so a core merge policy can require browser-session.",
  },
  {
    id: "A6-G6-interactive-sign-in-service",
    port: "identity",
    owedUntil: "2026-11-25",
    what: "beginSignIn/completeSignIn assume the adapter's process writes sessions. Cloud's sign-in (email code via Cognito, OIDC, SAML, Slack, GitHub) runs in the separate developer sign-in service, which alone writes the sign-in table (R13). The port needs a way to say 'sign-in is hosted elsewhere at this address'.",
    meanwhile: "capabilities.interactiveSignIn is false; sign-in stays on Cloud's sign-in service.",
  },
];
