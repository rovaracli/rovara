# kwidx-leftovers progress

- created: 2026-11-12 23:50 EST by new-lane.sh
- worktree: /Users/abhishekgarg/web/Rovara-kwidx-leftovers-20261112
- branch: fix/0517-keyword-index-leftovers (no upstream; push only to the Cloud remote (origin) when told to)
- base: origin/integ/0516 @ 2276358380c861abe6b6d560e8f2a4354fe164be
- node_modules donor: /Users/abhishekgarg/web/Rovara-te-b9-cloud-20261113

## Log
- 2026-11-13: finding 7a (segment cache: evict on retire/rebuild/damage/erase; `retainOnly` on every manifest read), 7b (chunk writes check the build's intent in a transaction, closing the eraseProject race; DEFERRED KWL-1/2 for the bounds), 8 (rank returns up to KEYWORD_CANDIDATES_MAX=500, query checks visibility 100 at a time until 100 visible or the end; DEFERRED KWL-3). New tests: tests/unit/team-record-core/keyword-index-leftovers.test.ts (13).

## Mutation runs (each mutation applied alone, the 6 keyword-index files run: core keyword-index, -erase, -review, -eval, -leftovers + wiring keyword-index-job; file restored after each)

Review findings 2-5 (the checker's list):
- F2 `docOfItem` keeps rows with hotExpiresAt <= now: 1 failed / 71 passed.
  - keyword-index-review > "review: the TTL window and archived rows" > "a row the TTL removed (hot + 7.5 days) has no words in the index (they went the night after its hot expiry)"
- F3 `cleanOrphans` deletes a listed segment's chunks (live set emptied): 1 failed / 71 passed.
  - keyword-index-review > "review: a segment the manifest lists is never taken for an orphan, and a damaged one is rebuilt" > "a live segment's build intent that outlived its switch: only the intent is deleted, the chunks stay and the index keeps working"
- F4 the gate swallows a failure again (no failed count, no log): 1 failed / 71 passed.
  - keyword-index-review > "review: the kill switch and the gate" > "the gate counts and logs a failure instead of swallowing it, and the delete worker reports it"
- F5 `keywordIndexIsOn` ignores the setting: 2 failed / 70 passed.
  - keyword-index-job > "the schedules run the keyword index's maintenance" > "the kill switch (broker setting `tw`, TEAM_RECORD_KEYWORD_INDEX)" > "is on unless the setting is exactly 0 (the default is ..."
  - keyword-index-job > same describe > "off: the job builds nothing and a search reads the wi[ndow]..."

New fixes (leftovers test file):
- search does not prune the cache (`retainOnly` removed from openKeywordIndex): 2 failed ("a search in ANOTHER warm container ... drops the segments it no longer lists"; "an erased index (a project archive) leaves nothing of it in a container that searches afterwards").
- `markDamaged` without evict: 1 failed ("marking a segment damaged drops it from the cache and marks it dirty").
- `eraseKeywordIndexItems` without cache clear: 1 failed (after adding "the container that erases a project's index (an archive) drops that project's cached segments at once"; it survived before that test was added).
- `deleteChunks` without evict: 1 failed (after adding "deleting a retired segment's chunks ... drops it from the cache"; survived before).
- chunk write without the intent check: 1 failed ("a build that is still writing when the project's index is erased cannot leave chunks behind, even if its own clean-up then fails").
- finding 8, no extra batches / rank top back to 100: each 2 failed ("a visible row ranked behind more than 100 rows the reader may not see is still returned"; "a hidden row is never in the result, ...").
- finding 8, extra batches skip filterVisible: 2 failed (same two tests; the hidden-row test catches it).
