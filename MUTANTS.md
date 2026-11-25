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
