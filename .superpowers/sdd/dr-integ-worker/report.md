# DR5 integration merge (branch feat/dr-integ-worker)

Base bf15220a1 (combined design review + fix-workflow + fix-proof). Merged feat/dr-worker 0448cfa24. Commit 2fec0ccc6 (local, not pushed).

## What was resolved
- Conflict: `packages/broker/src/design-review/packet.ts`. Took the fix-proof file, then removed everything DR5 had moved.
- ONE copy of framing, in `packages/contracts/src/design-review-packet.ts`, byte-identical to the fix-proof code: `neutralizePacketText` (frame-like tags defused in any spelling, invisible characters removed), `renderPacketDocument` (frame carries kind, ref, at, digest; MCP ref is `sourceId:itemRef`), `renderPacketRequest`, `itemOf`, `packetDigestOf` (prompt bound by `promptDigest`), `reviewerMessagesOf`. Also moved to contracts: `PACKET_FRAME_TAGS`, `promptDigest`. Broker `prompts/common.ts` and `prompts/index.ts` re-export them.
- Broker `packet.ts` keeps: closed `PacketBuildInputSchema` (no tool/args/rolePrompt), registry-only prompt, MCP allowlist (`mcp-allowlist.ts`), caps, per-reader timeout and deadline, ref rules. It re-exports the render/digest functions from contracts.
- Worker (`design-review.ts`, `design-review-sessions.ts`) needed no API change for rendering: it already used `reviewerMessagesOf`, which now renders the fixed frames. A delivery with any other prompt text, version or id fails the digest check (`packet_changed`; tested).
- `mergeDesignFindings` is called with `verifiedRoles` in both the worker (roles whose answer was read) and `assembleRoundFindings` (counted reviewers). `rawFindings` flow through the code merge and the model merge (tested, result schema parses).
- `inputProof` is carried per reviewer in `assembleRoundFindings` (typed from verify.ts, tested for both proofs).
- Citation check compares `source` citations with the item `ref` and digest; the ref is the one the frame shows. Test builds a real packet, copies ref and digest out of the rendered frame, and shows `tracker:ABC-1` accepted, the route label `ABC-1` and `tracker:search:ABC-1` dropped.

## Minor 7 (Light tier critic paraphrase)
- `LIGHT_CRITIC_PROMPT_ID` and `lightCriticWritesParaphrase(role, promptId)` in contracts (`design-review.ts`).
- New registered prompt `prompts/critic-light.ts` (id `design-review-critic-light`, version 1): the Critic plus a "FIRST, THE PARAPHRASE" step and the paraphrase output block. In the registry (`ALL_DESIGN_REVIEW_PROMPTS`), with the attribution header. `reviewerPromptFor(role, tier)` picks it for the Critic of the Light tier only.
- Builder input gets an optional `tier` (enum). It only picks between registered prompts; there is still no field for prompt text.
- Worker reads with `{ withParaphrase }` when the delivered prompt id is the Light one (the id is inside the packet digest, so the worker cannot be misled). Broker `assembleRoundFindings` takes optional `promptIds` (role -> id from `BuiltPacket.rolePrompt.id`) and does the same.
- `ReviewerRunSchema` allowed a paraphrase for the comprehension reviewer only; it now also allows the Light Critic's prompt id (otherwise the paraphrase could never be recorded).

## Mutation proof
In contracts `neutralizePacketText`, replaced the fix with DR5's old `replaceAll("</source-file", ...)`: 7 tests failed (frames M1 x6 in `design-review-packet-frames.test.ts`, builder M1/M2 in `design-review-packet.test.ts`, worker frame test). Restored (file identical to the committed copy); all green again.

## Tests
- New `tests/unit/design-review-packet-frames.test.ts`: the fix-proof M1/M2/M5 framing tests, ported to call the contracts module directly (hand-built documents), plus "one copy" (broker exports are the same function objects).
- `design-review-packet.test.ts`: M1/M2 builder-level tests reduced to what only the builder can show; tier test added.
- `design-review-worker.test.ts`: `packetFor` no longer passes a rolePrompt; new block "integration of the DR3/DR4 proof fixes" (frames, prompt swap refused, Light paraphrase, rawFindings, inputProof, promptIds). Two merge texts changed to the raw findings' own words (the M3 rule made the old invented texts fall back to the code merge).
- `design-review-citations.test.ts`, `design-review-prompts.test.ts`, `design-review-contracts.test.ts` extended.

## Gates
- `tsc -b --pretty false`: clean. `npm run build:web`: ok.
- 15 `*design-review*` test files (unit + contract): 407 passed. There is no `*worker*design*` test file; the worker tests are `design-review-worker.test.ts`.
- Inventory and neighbours (task-owner-reads, task-owner-reads-bypass, agent-lifecycle, contracts-web-entry, role-sites, broker-environment-provided, admin-health-infrastructure, audit-outbox, egress outbound-hosts, ec2-dispatch, rovara-code-critic): 969 passed, 1 failed = role-sites (below). admin-health-infrastructure and audit-outbox pass at this head.
- `role-sites` fails with ONE site: `packages/contracts/src/design-review.ts` (`finding.fromReviewers.every((role) => ... entry.role === role)`, from the fix-proof M3 superRefine; line 218 at bf15220a1, 227 now). It fails identically at bf15220a1, so it is not from this merge; the system-owner.ts site from the controller note no longer shows. Fix is one entry in `tests/roles/role-sites-reviewed.ts` ("a reviewer role of a finding, not an account role"). Left alone (not mine to widen); the controller should add it.
- `second-review-worker.test.ts` "a try that would run past the shared budget": at this head 4 failures in 9 runs, at bf15220a1 (detached worktree, removed) 1 failure in 6 runs (load average 25 to 30). It asserts elapsed < 1950 ms and failed with 2300 to 3700 ms. The test does not touch design review; it is load-sensitive on both heads.
- `node scripts/check-worker-dist.ts`: exit 0.
- eslint on all changed files: clean.
- `scripts/codemap.ts` does not exist on this branch, so it was not run.
- `typecheck-baseline.ts check --changed`: see the line at the end of this report.

## For DR7 and later (wiring, nothing done here)
- The packet route returns `PacketDeliverySchema` (rolePrompt without `digest`): strip `digest` from `BuiltPacket.rolePrompt`.
- Pass `tier` to `buildReviewerPacket`, and `promptIds` to `assembleRoundFindings`, from the project's tier.
- Card: `inputProofSentence(run.inputProof)`; label `filesRead` with `FILES_READ_LABEL`. `mcpItemReaderOf(call, { sources, now, newRequestId })`; check the default MCP argument `{ id: itemRef }` on staging.
- Carry-over by `designFindingCoveredBy`, and requiring `rawFindings` for reviewer findings, is now possible (rawFindings is always filled by the merges).
- Prompt version note: the Light Critic starts at version 1; all others are 2.
- `typecheck-baseline.ts check --changed --base bf15220a1`: exit 0, 0 errors in 0 files (27 of 30 programs). The first run found 1 strict error in the DR5 worker test (an invalid `inputProof` value); fixed in commit "Fix the proof value...". Strict shards pkg-broker, pkg-contracts, pkg-worker, tests-unit-a-e, tests-contract-d, tests-contract-s: 0 errors.
