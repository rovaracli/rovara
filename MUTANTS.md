# Mutant evidence (append-only)

## GATEWAY-IMAGE-BY-CONTENT, part (a): content-tagged gateway image (pr/gateway-image-by-content-20261125)

Each mutant was applied singly, in place, to one product line of `ops/pipeline/steps/image.ts` or `ops/pipeline/lib/ecr.ts`, the tests `tests/contract/pipeline-image-price.test.ts` and `tests/contract/pipeline-stage-flow.test.ts` were run, and the file was restored (`git status` clean after). Run at 73938f2bb (after the Sonnet pre-review fixes). M1-M11 are the pre-review's 11 mutants; M12-M15 are mutants of the guards added by the fixes.

| # | Mutant | Before the fixes (Sonnet pre-review) | After the fixes | Killed by |
|---|--------|---|---|---|
| M1 | skip the exists-check (always build) | killed | KILLED | reuse tests (3) |
| M2 | tag from the execution id instead of content | killed | KILLED | 8 tests |
| M3 | production copy ignores the recorded tag | killed | KILLED | 4 tests |
| M4 | `contentTagFor` without the 64-hex check | killed | KILLED | bad-hash test, tag table |
| M5 | tag keeps 12 hex instead of the full hash | killed | KILLED | 8 tests |
| M6 | context script exit code ignored | survived | KILLED | "exits non-zero after printing a valid-looking hash" |
| M7 | first stdout line instead of the last | survived | KILLED | "the hash is the LAST stdout line" (noise line first) |
| M8 | no `removeDir` after (the `finally`) | survived | KILLED | non-zero-exit test and stale-dir test (dir gone after failure and success) |
| M9 | no `removeDir` before | survived | KILLED | "directory left by a crashed earlier attempt" (the fake refuses a non-empty --out like assembleContext) |
| M10 | `BUILT_TAG` drops the older `pipe-` form | killed | KILLED | recorded-tag table |
| M11 | reuse path without the digest-shape check | survived | KILLED | "ECR answer that is not a digest on the reuse path" |
| M12 | no cross-check of the build's context hash against the tag's | n/a (new guard) | KILLED | "context the build used must be the one the tag was made from" |
| M13 | no check that the candidate tree is at the manifest commit | n/a (new guard) | KILLED | "clean checkout of the manifest's Cloud commit" |
| M14 | no dirty / untracked-file check on the gateway build inputs | n/a (new guard) | KILLED | same test |
| M15 | no refusal when the build prints no context hash | n/a (new guard) | KILLED | same test as M12 |

Result: 11 of 11 pre-review mutants killed (6 were killed before, 5 survivors now killed); 4 of 4 new-guard mutants killed.

### Update: Opus release-safety SHOULDs S1 and S2 (script identity in the hash, `--ignored` check)

Same method (singly, in place, restored). The hash now covers `scripts/model-gateway-image.ts`'s own sha256 and `IMAGE_FORMAT_VERSION`; the clean-tree check lists the script and also runs `git status --ignored` under `packages/model-gateway/src`. Tests run: `pipeline-image-price`, `model-gateway-image`.

| # | Mutant | Result | Killed by |
|---|--------|--------|-----------|
| M16 | context hash ignores the script identity (script bytes and `IMAGE_FORMAT_VERSION`) | KILLED | "the context hash also covers this script and its format version" (`tests/contract/model-gateway-image.test.ts`) |
| M17 | clean-tree path list drops `scripts/model-gateway-image.ts` | KILLED | the exact git command line pinned in the first beta image test |
| M18 | no `--ignored` check under the gateway source | KILLED | "clean checkout of the manifest's Cloud commit" (ignored `src/dist/extra.ts` refused) |
# BEDROCK-BYO-CHECK-FIXES mutant evidence (append only)

Each mutant was applied singly to the worktree, the named tests were run, and the file was restored (all restored runs pass).

| Mutant | Change | Killed by | Result |
| --- | --- | --- | --- |
| M1, `#modelCheck` (bedrock-byo-sessions.ts) | drop the retry (`if (false && seen.again ...)`) | tests/unit/model-gateway-bedrock-byo-sessions.test.ts: "asks once more when AWS answers 5xx..." and "logs both asks when it retries..." | red (2 of 18) |
| M2, `classifyAnswer`/`#ask` | map `no_answer` back to `unavailable` (every place the word is produced) | same file: "tells each model's state...", the retry test, the caller-abort test, the retry-log test | red (4 of 18) |
| M3, `checkBedrock` (bedrock-byo-routes.ts) | the check route skips the admin permission check (any signed-in company member passes) | tests/unit/bedrock-byo-cloud-connect.test.ts: "Check again needs the same permission as connecting..." and the bad-body test | red (2 of 13) |
| M4, `BedrockForm` (BedrockConnection.tsx) | the Region defaults to us-west-2 when nothing is saved or typed | tests/web/bedrock-connection-draft.test.ts: "starts empty, with no built-in Region..." and "a company's draft never shows to another company..." | red (2 of 36 across the two Bedrock web files) |
| M5, `checkBedrock` | no 30-second limit | tests/unit/bedrock-byo-cloud-connect.test.ts: "Check again is limited to once per 30 seconds..." and the failed-try case | red (2 of 13) |
| M6, `#ask` | the error type logged is the first 200 characters of AWS's answer (its words) | tests/unit/model-gateway-bedrock-byo-sessions.test.ts: the two logging tests | red (2 of 18) |
| M7, `classifyAnswer` | any 2xx is ready (no check of the answer's shape) | same file: "tells each model's state..." (odd 200 bodies) and the retry test | red (2 of 18) |
| M8, `checkBedrock` | the limit ignores the saved `checkedAt` (only this process's last try) | tests/unit/bedrock-byo-cloud-connect.test.ts: "Check again is limited to once per 30 seconds..." | red (1 of 13) |
| M9, `BedrockForm` | the form ignores the draft and the saved role ARN (remount resets it) | tests/web/bedrock-connection-draft.test.ts: remount, saved-seed and save tests | red (4 of 8) |
| M10, `BedrockForm` | the button only re-reads (does not call the check route) | tests/web/bedrock-connection-draft.test.ts: the two Check tests | red (2 of 8) |
| M11, `recheckBedrock` (product-keys.ts) | a check again saves nothing new (the old summary stays) | tests/unit/model-gateway-bedrock-byo.test.ts: "a check again re-runs the test for the SAVED connection..." | red (1 of 27) |

## Pre-review round (applied to f1a55c77c plus the pre-review fixes of this commit; append only)

| Mutant | Change | Killed by | Result |
| --- | --- | --- | --- |
| M12, `classifyAnswer` | retry on any status of 400 or more (not only 5xx) | model-gateway-bedrock-byo-sessions.test.ts: "asks once more..." (401, 408, 413, 422, 424, 499 are one ask) | red (1 of 20) |
| M13, `expectedAnswer` | a Messages answer is ready only with stop_reason max_tokens | same file: "tells each model's state..." (end_turn, stop_sequence) | red (1 of 20) |
| M14, `#modelCheck` | no budget check before the retry | same file: "does not ask again when a whole ask no longer fits..." | red (1 of 20) |
| M16, `answerBedrockCheck` | no per-company limit (a second probe of the same company starts) | bedrock-byo-cloud-connect.test.ts: "one probe at a time and 6 a minute per company..." | red (1 of 16) |
| M17, `parseDoc` | a state word this release does not know is kept as it is | model-gateway-bedrock-byo.test.ts: "a state word a later release stored reads as no_answer..." | red (1 of 29) |
| M17b, `validBedrockSummary` | the strict word list again (an unknown word fails the whole document) | same test | red (1 of 29) |
| M18, `#logCheck` | the company id is left out of the log line | sessions test: both logging tests | red (2 of 20) |
| M9s, `recheckBedrock` | a good re-check keeps a call-time refusal marker | model-gateway-bedrock-byo.test.ts: "a check again clears a call-time refusal marker..." | red (1 of 29) |
| M15, `checkBedrock` | a stale or vanished-connection refusal still spends the 30 seconds | bedrock-byo-cloud-connect.test.ts: "a refused Check again... does not spend the 30 seconds" | red (1 of 16) |
| M21, `checkBedrock` | no audit row for a Check again | same file: the Check again test and the refused-check test | red (2 of 16) |
| M19, `check()` (BedrockConnection.tsx) | the fresh read is not stored before the POST | tests/web/bedrock-connection-draft.test.ts: "a refused re-check shows the fresh read first..." | red (1 of 11) |
| M20, `check()` | a 401/403 only shows a notice (the connection and role ARN stay) | same file: "a re-check refused as 403 ... or 404 ..." | red (1 of 11) |
| M22, `check()` | a 404 does not re-read | same test | red (1 of 11) |
| M23, `gatewayBedrockCheck` | the product models are not sent to the gateway | tests/unit/bedrock-byo-cloud-connect.test.ts: "the gateway is told the connection's product models..." | red (1 of 17) |
| M24, `gatewayBedrockCheck` | the answer is read only for the agents' picks (product models read unavailable) | same test | red (1 of 17) |
