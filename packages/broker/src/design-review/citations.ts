// Design review stage, DR5: the citation check, as the broker applies it. The function is pure and lives in contracts (design-review-citations.ts) because the worker runs the same check for early feedback
// and cannot import from the broker. The broker applies it to the answers it reads itself and the packets it built, never to what the worker says it kept.
// Wiring (DR7): after `readDesignReview` of each reviewer's uploaded answer, call `filterReviewerCitations(raw, packetsByRole)` with `packetsByRole` made from each BuiltPacket's `items`, then merge what is left
// (`mergeDesignFindings`), then add the findings of `own-findings.ts`. Record `droppedFindings` on the task so the card can say "N findings were not used: no citation matched what the reviewer was given".
export {
  CITATION_DROP_REASONS, checkResolveCitations, citationProblem, filterReviewerCitations,
  type CitablePacketItem, type CitationDropReason, type CitationFilterResult, type DroppedCitation, type DroppedFinding, type PinnedCommits, type ResolveCitationResult, type ReviewerPackets,
} from "@agentx/contracts";
