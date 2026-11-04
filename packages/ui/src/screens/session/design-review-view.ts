// Design review (DR11): what the task page's Design tab says, worked out from the stored review as plain strings and small records. Pure: no React, no clock, no network.
// Every string that came from a model (a finding, a note, a paraphrase, a question) is carried unchanged and shown through `VisibleText`: it is text and nothing else. A hidden or bidirectional
// control character shows as [U+XXXX]; markdown, HTML and links in it stay literal. The only link on the tab is `codeLink`, built from the encoded `codeCitationLinkPath` and a base the broker's own
// record of the task's repositories gave (never from model text).
import {
  CODE_CITATION_UNCHECKED, DESIGN_SECTIONS, DESIGN_SOURCE_ONLY_LABEL, designFindingIsSourceOnly, FILES_READ_LABEL, codeCitationInPacket, codeCitationLinkPath, designFindingRaisedBefore, designReasonPhrase, designReviewDisagreements, inputProofSentence, resolutionOf,
  type CitablePacketItem, type DesignCitation, type DesignDisagreementKind, type DesignFinding, type DesignQuestion, type DesignReason, type DesignReviewRound, type DesignReviewTier, type DesignReviewView,
  type FindingResolution, type ReviewerRole, type ReviewerRun,
  DesignActionsViewSchema, WorkflowDesignReviewSchema, type DesignActionsView,
} from "@agentx/contracts/web";

export const ROLE_WORDS: Readonly<Record<ReviewerRole, string>> = {
  comprehension: "Comprehension reviewer", critic: "Critic", codebase: "Codebase reviewer", zoom_out: "Zoom-out reviewer", critic_b: "Second critic",
};
export const TIER_WORDS: Readonly<Record<DesignReviewTier, string>> = {
  light: "Light (one reviewer, merged without a model)", standard: "Standard (three reviewers and a merge step)", thorough: "Thorough (up to five reviewers and a merge step)",
};
export const STATUS_WORDS: Readonly<Record<DesignReviewView["status"], string>> = {
  estimating: "Working out the cost", waiting_cost: "Waiting for a person to decide on the cost", running: "Reviewers are reading the design", resolving: "The planner is answering the findings",
  waiting_answers: "Waiting for answers to the design questions", done: "Done", not_run: "Did not run", stopped_at_cap: "Stopped at the cost limit",
};
export const NOT_RUN_WORDS: Readonly<Record<NonNullable<DesignReviewView["notRunReason"]>, string>> = {
  no_model_source: "Design review did not run: this project has no model source it can use for it.",
  no_verified_model: "Design review did not run: no model is verified for the reviewers.",
  cost_declined: "Design review did not run: the cost was not approved.",
  timeout: "Design review did not run: the reviewers ran out of time.",
  worker_failed: "Design review did not run: the reviewers did not start or did not finish.",
  inputs_unverified: "Design review did not count: Rovara could not verify what the reviewers were given.",
  rearm_limit: "Design review did not run again: the design was sent back more often than the limit allows. Raise the cost limit or pick a lower tier to review it again.",
  skipped: "Design review was skipped by a person.",
  cancelled: "Design review did not finish: the run was stopped.",
  task_limit: "Design review did not run: the task's own run limit has too little room left for it. This is the task's limit, not the design review cost limit.",
  switched_off: "Design review stopped: it was switched off for this project. The design is shown as it stands, with the findings not yet answered. Nothing was approved.",
};
const VERIFY_FAILURE_WORDS: Readonly<Record<NonNullable<ReviewerRun["verifyFailure"]>, string>> = {
  packet_digest_mismatch: "what the reviewer read did not match the packet Rovara built",
  session_reused: "the reviewer's session was not new",
  tool_not_read_only: "the reviewer used a tool that can change things",
  model_key_mismatch: "the reviewer did not use the key Rovara gave it",
  first_call_mismatch: "the size of the reviewer's first call did not match its packet",
  no_usage_record: "there is no usage record for the reviewer",
  unreadable_output: "the reviewer's answer could not be read",
  timeout: "the reviewer ran out of time",
};
const SEVERITY_WORDS = { blocker: "Blocker", major: "Major", nit: "Nit" } as const;
const ACTION_WORDS: Readonly<Record<FindingResolution["action"], string>> = {
  fixed: "The planner fixed it in the design.", contested: "The planner disagrees, and gave evidence.", asked: "The planner turned it into a question for a person.", declined: "The planner chose not to act on it.",
};
const DISAGREEMENT_WORDS: Readonly<Record<DesignDisagreementKind, string>> = {
  contested: "The planner contested this blocker with evidence.",
  unresolved: "Nobody resolved this.",
  unchecked_fix: "The planner says it fixed this, and no reviewer read the fix.",
  oscillation: "Fixing this would undo an earlier fix, so a person decides.",
};

/** `$1.10`, or "not available" for a value that is not a usable amount. */
export function usdWords(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) || value < 0 ? "not available" : `$${value.toFixed(2)}`;
}

export interface CitationLine { text: string; /** True for a code path nobody checked: Rovara only has the reviewer's word that it exists at the pinned commit. */ unchecked: boolean; /** An https link, only where `codeLinkBase` named the repository. */ href?: string | undefined }
export type CodeLinkBase = (repo: string) => string | undefined;

/** How a citation reads on the tab. A code path that matched a file the reviewer was given reads as a path; any other is labelled "not checked" (it is the reviewer's claim). */
export function citationLine(citation: DesignCitation, packet: readonly CitablePacketItem[], codeLinkBase?: CodeLinkBase): CitationLine {
  switch (citation.kind) {
    case "design": return { text: `design ${citation.section}`, unchecked: false };
    case "source": return { text: `source ${citation.ref}`, unchecked: false };
    case "code": {
      const unchecked = !codeCitationInPacket(citation, packet);
      const lines = citation.endLine > citation.startLine ? `${String(citation.startLine)}-${String(citation.endLine)}` : String(citation.startLine);
      const text = `${citation.repo}:${citation.path}:${lines}${unchecked ? ` (${CODE_CITATION_UNCHECKED})` : ""}`;
      const base = codeLinkBase?.(citation.repo), tail = codeCitationLinkPath(citation);
      if (base === undefined || tail === undefined) return { text, unchecked };
      const anchor = citation.endLine > citation.startLine ? `#L${String(citation.startLine)}-L${String(citation.endLine)}` : `#L${String(citation.startLine)}`;
      return { text, unchecked, href: `${base.replace(/\/+$/u, "")}/blob/${tail}${anchor}` };
    }
  }
}

export interface ReviewerLine { role: string; model: string; verified: boolean; proof: string; filesRead: { label: string; files: string[] }; cost: string; tokens: string }
export function reviewerLine(run: ReviewerRun): ReviewerLine {
  // A verified run says what proved its input, in the contract's fixed words, and nothing stronger. One stored without a proof says so.
  const proof = run.verified
    ? (run.inputProof === undefined ? "verified (what proved it was not recorded)" : inputProofSentence(run.inputProof))
    : `not verified, so its result does not count: ${run.verifyFailure === undefined ? "no reason recorded" : VERIFY_FAILURE_WORDS[run.verifyFailure]}`;
  return {
    role: ROLE_WORDS[run.role], model: `${run.model.provider} ${run.model.modelId}`, verified: run.verified, proof,
    filesRead: { label: `Files read (${FILES_READ_LABEL}, not checked by Rovara)`, files: [...run.filesRead] },
    cost: usdWords(run.costUsd), tokens: `${String(run.tokensIn)} tokens in, ${String(run.tokensOut)} out`,
  };
}

export interface ResolutionLine { action: FindingResolution["action"]; words: string; note: string; evidence: CitationLine[]; settled: boolean; question?: string | undefined }
export interface FindingLine {
  id: string; severity: DesignFinding["severity"]; severityWords: string; section: string; text: string; citations: CitationLine[]; reviewers: string[]; addedByRovara: boolean; raisedAgain: boolean;
  /** "source-only" when the finding cites source items alone and neither the design nor the code (3.12 item 5); it is labelled and still counts as open. */
  sourceOnly: string | undefined;
  /** The reviewers' own words behind a merged finding, when the merge step grouped several. */
  raw: Array<{ role: string; severity: string; text: string }>;
  resolution?: ResolutionLine | undefined;
}
export interface SectionGroup { section: string; findings: FindingLine[] }
export interface RoundLine {
  round: number; designVersion: string; reviewers: ReviewerLine[]; verifiedCount: number; groups: SectionGroup[]; findingCount: number; unresolved: number;
}

const SEVERITY_ORDER = { blocker: 0, major: 1, nit: 2 } as const;
/** The packet items the reviewers of a finding were given: the evidence a code citation is matched against. A finding Rovara added itself has none. */
function packetOf(round: DesignReviewRound, roles: readonly ReviewerRole[]): CitablePacketItem[] {
  return round.reviewers.filter((run) => roles.includes(run.role)).flatMap((run) => run.packet.map((item) => ({ kind: item.kind, ref: item.ref, commitOrFetchedAt: item.commitOrFetchedAt, digest: item.digest })));
}
function allPackets(round: DesignReviewRound): CitablePacketItem[] {
  return round.reviewers.flatMap((run) => run.packet.map((item) => ({ kind: item.kind, ref: item.ref, commitOrFetchedAt: item.commitOrFetchedAt, digest: item.digest })));
}

function findingLine(review: DesignReviewView, round: DesignReviewRound, finding: DesignFinding, codeLinkBase?: CodeLinkBase): FindingLine {
  const own = packetOf(round, finding.fromReviewers), resolution = resolutionOf(round, finding.id);
  return {
    id: finding.id, severity: finding.severity, severityWords: SEVERITY_WORDS[finding.severity], section: finding.section, text: finding.text,
    citations: finding.citations.map((citation) => citationLine(citation, own, codeLinkBase)),
    reviewers: finding.fromReviewers.map((role) => ROLE_WORDS[role]), addedByRovara: finding.origin === "rovara", sourceOnly: designFindingIsSourceOnly(finding) ? DESIGN_SOURCE_ONLY_LABEL : undefined,
    raisedAgain: designFindingRaisedBefore(review, round.round, finding) !== undefined,
    raw: (finding.rawFindings ?? []).map((entry) => ({ role: ROLE_WORDS[entry.role], severity: SEVERITY_WORDS[entry.severity], text: entry.text })),
    resolution: resolution === undefined ? undefined : {
      action: resolution.action, words: ACTION_WORDS[resolution.action], note: resolution.note, settled: resolution.settled,
      // A planner's evidence is matched against everything the round's reviewers were given (the same rule the broker applies).
      evidence: (resolution.evidence ?? []).map((citation) => citationLine(citation, allPackets(round), codeLinkBase)), question: resolution.questionId,
    },
  };
}

/** One round: its reviewers and its findings grouped by design section (sections in design order, the worst finding first within each). */
export function roundLine(review: DesignReviewView, round: DesignReviewRound, codeLinkBase?: CodeLinkBase): RoundLine {
  const lines = round.findings.map((finding) => findingLine(review, round, finding, codeLinkBase));
  const groups: SectionGroup[] = [];
  for (const section of DESIGN_SECTIONS) {
    const inSection = lines.filter((line) => line.section === section).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    if (inSection.length > 0) groups.push({ section, findings: inSection });
  }
  return {
    round: round.round, designVersion: round.designDigest.slice(0, 8), reviewers: round.reviewers.map(reviewerLine), verifiedCount: round.reviewers.filter((run) => run.verified).length, groups,
    findingCount: lines.length, unresolved: lines.filter((line) => line.resolution === undefined).length,
  };
}

export interface DisagreementLine {
  findingId: string; round: number; severity: "Blocker" | "Major"; kindWords: string; raisedAgain: boolean; reviewerSide: { text: string; citations: CitationLine[]; reviewers: string[] };
  /** The planner's side; absent when nobody answered. */
  plannerSide?: { words: string; note: string; evidence: CitationLine[] } | undefined;
}
/** The "Disagreements" list: both sides of every place a reviewer and the planner differ, from `designReviewDisagreements` (the same list the decision card counts). */
export function disagreementLines(review: DesignReviewView, codeLinkBase?: CodeLinkBase): DisagreementLine[] {
  return designReviewDisagreements(review).flatMap((entry) => {
    const round = review.rounds[entry.round - 1], finding = round?.findings.find((candidate) => candidate.id === entry.findingId);
    if (round === undefined || finding === undefined) return [];
    const line = findingLine(review, round, finding, codeLinkBase);
    return [{
      findingId: finding.id, round: entry.round, severity: entry.severity === "blocker" ? "Blocker" : "Major", kindWords: DISAGREEMENT_WORDS[entry.kind], raisedAgain: entry.raisedAgain,
      reviewerSide: { text: line.text, citations: line.citations, reviewers: line.reviewers },
      plannerSide: line.resolution === undefined ? undefined : { words: line.resolution.words, note: line.resolution.note, evidence: line.resolution.evidence },
    }];
  });
}

export interface QuestionLine {
  id: string; unclear: string; evidence: CitationLine[]; options: Array<{ id: string; label: string; consequence: string; recommended: boolean; chosen: boolean }>; recommended: string; why: string;
  /** What a person answered, in their words, when they did. */
  answerText?: string | undefined;
}
/** The questions of the latest round that has any, with Rovara's recommendation beside the options and any answer a person gave. */
export function questionLines(review: DesignReviewView, codeLinkBase?: CodeLinkBase): { round: number; questions: QuestionLine[] } | undefined {
  const round = [...review.rounds].reverse().find((candidate) => (candidate.questions ?? []).length > 0);
  if (round === undefined) return undefined;
  const items = allPackets(round), answers = round.answers?.answers ?? [];
  const line = (question: DesignQuestion): QuestionLine => {
    const answer = answers.find((candidate) => candidate.questionId === question.id);
    return {
      id: question.id, unclear: question.unclear, evidence: question.evidence.map((citation) => citationLine(citation, items, codeLinkBase)), recommended: question.recommended, why: question.why,
      options: question.options.map((option) => ({ id: option.id, label: option.label, consequence: option.consequence, recommended: option.id === question.recommended, chosen: answer?.optionId === option.id })),
      answerText: answer?.text,
    };
  };
  return { round: round.round, questions: (round.questions ?? []).map(line) };
}

/** The comprehension reviewer's "what this proposes" (or the Light tier's Critic's), labelled as the reviewer's words and never as Rovara's statement. */
export function paraphraseLine(review: DesignReviewView): { by: string; text: string } | undefined {
  for (const round of [...review.rounds].reverse()) {
    const run = round.reviewers.find((candidate) => candidate.paraphrase !== undefined && candidate.verified);
    if (run?.paraphrase !== undefined) return { by: `In the words of the ${ROLE_WORDS[run.role].toLowerCase()} (not Rovara's statement)`, text: run.paraphrase };
  }
  return undefined;
}

/** The reasons as fixed phrases, never as a model's words. */
export const reasonPhrases = (reasons: readonly DesignReason[]): string[] => reasons.map((reason) => designReasonPhrase(reason));

/**
 * The classification line (1.2) as the task page words it from the stored review: why the review is on, in fixed words. The model's one-line note is NOT in this line; the tab shows it apart, labelled as
 * Rovara's reading of the request.
 */
export function classificationLine(review: Pick<DesignReviewView, "decidedBy" | "reasons" | "fromQuick">): string {
  const reasons = reasonPhrases(review.reasons).join("; ");
  const why = reasons === "" ? "" : ` Reason: ${reasons}.`;
  const quick = review.fromQuick === true ? " It was started from a Quick plan; that plan stays on the task as history." : "";
  switch (review.decidedBy) {
    case "person": return `Design review: on, because a person asked for design first.${why}${quick}`;
    case "always": return `Design review: on, because this project reviews the design of every code change.${why}${quick}`;
    case "person_skip": return `Design review: skipped by a person.${why}`;
    case "never": return `Design review: off for this project.${why}`;
    case "auto": return `Design review: needed.${reasons === "" ? " Reason: Rovara's reading of the request." : ` Reason: ${reasons} (Rovara's reading of the request).`}${quick}`;
  }
}

/** The line shown before any review exists, from what Understand returned: "not needed" with its reason, and that Design first is available. */
export function notNeededLine(design: { reasons: readonly DesignReason[] } | undefined): string {
  const reasons = design === undefined ? "" : reasonPhrases(design.reasons).join("; ");
  return `Design review: not needed.${reasons === "" ? "" : ` Reason: ${reasons}.`} Design first is available.`;
}

export interface DesignTabModel {
  classification: string;
  /** Rovara's one-line reading of the request: model words, shown apart and labelled. */
  reading?: string | undefined;
  statusWords: string;
  tierWords: string;
  cost: { estimate: string; spent: string; limit: string };
  notRun?: string | undefined;
  /** "Design review, round 1 of 2: reviewers reading the design." while it runs. */
  progress?: string | undefined;
  decisions: string[];
  waiting?: string | undefined;
  rounds: RoundLine[];
  disagreements: DisagreementLine[];
  paraphrase?: { by: string; text: string } | undefined;
  questions?: { round: number; questions: QuestionLine[] } | undefined;
  earlier?: string | undefined;
}

/** Shown while the review is switched on but the planner has not written the design yet (a Full task still in its requirements, or writing the design): there is no cost to work out yet. */
export const AWAITING_DESIGN_WORDS = "Waiting for the design";

/**
 * What the Design tab shows, all of it. `note` is Understand's one-line reading, when the page has it. `designWritten` is whether the task has a design document yet (the caller reads the task's artifacts):
 * a review that is "estimating" with no rounds and no design is waiting for its first design, not working out a cost.
 */
export function designTabModel(review: DesignReviewView, options: { note?: string | undefined; codeLinkBase?: CodeLinkBase | undefined; designWritten?: boolean | undefined } = {}): DesignTabModel {
  const codeLinkBase = options.codeLinkBase, note = options.note ?? review.note;
  const approvals = (review.approvals ?? []).map((approval) => {
    switch (approval.kind) {
      case "spend": return `A person approved the spend${approval.approvedUsd === undefined ? "" : ` (${usdWords(approval.approvedUsd)})`}.`;
      case "raise_cap": return `A person raised the limit from ${usdWords(approval.fromUsd)} to ${usdWords(approval.capUsd)}.`;
      case "lower_tier": return `A person lowered the tier from ${approval.from} to ${approval.tier}.`;
    }
  });
  const waiting = review.waiting;
  return {
    classification: classificationLine(review),
    reading: note === undefined || note === "" ? undefined : note,
    statusWords: review.status === "estimating" && review.rounds.length === 0 && options.designWritten === false ? AWAITING_DESIGN_WORDS : STATUS_WORDS[review.status], tierWords: TIER_WORDS[review.tier],
    cost: { estimate: usdWords(review.estimateUsd), spent: usdWords(review.spentUsd), limit: review.capUsd === undefined ? "not set" : usdWords(review.capUsd) },
    notRun: review.status === "not_run" && review.notRunReason !== undefined ? NOT_RUN_WORDS[review.notRunReason] : review.status === "stopped_at_cap" ? "Design review stopped because it reached the cost limit." : undefined,
    progress: review.status === "running" ? `Design review, round ${String(Math.min(review.rounds.length + 1, 2))} of 2: reviewers reading the design.` : undefined,
    decisions: approvals,
    waiting: waiting === undefined ? undefined : waiting.closedAt !== undefined ? "Closed as not decided after a long wait for answers." : waiting.parkedAt !== undefined ? "Parked: nobody answered for 7 days. Answering resumes it." : "Waiting for answers.",
    rounds: review.rounds.map((round) => roundLine(review, round, codeLinkBase)),
    disagreements: disagreementLines(review, codeLinkBase),
    paraphrase: paraphraseLine(review),
    questions: questionLines(review, codeLinkBase),
    earlier: (review.earlierReviews ?? []).length === 0 ? undefined : `${String((review.earlierReviews ?? []).length)} earlier review${(review.earlierReviews ?? []).length === 1 ? "" : "s"} of designs that were sent back (their cost counts toward the limit).`,
  };
}

/** The Design tab appears only when the task view carries a design review (Rovara Code version 2 reads). Every other task page is exactly as it was. */
export function hasDesignReview(workflow: { designReview?: DesignReviewView | undefined } | undefined): workflow is { designReview: DesignReviewView } {
  return workflow?.designReview !== undefined;
}

/**
 * The design review of a task view, read exactly: the task view comes through a tolerant reader (an unknown word becomes "unknown"), and a review with one is NOT guessed at. A record this version of the app
 * cannot read exactly is `"unreadable"`; the tab then says so instead of showing words Rovara did not mean.
 */
export function readDesignReview(value: unknown): DesignReviewView | "unreadable" | undefined {
  if (value === undefined) return undefined;
  const parsed = WorkflowDesignReviewSchema.safeParse(value);
  return parsed.success ? parsed.data : "unreadable";
}

/** The Design first and Skip buttons the broker offered, read exactly; anything this version cannot read offers nothing. */
export function readDesignActions(value: unknown): DesignActionsView | undefined {
  const parsed = DesignActionsViewSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
