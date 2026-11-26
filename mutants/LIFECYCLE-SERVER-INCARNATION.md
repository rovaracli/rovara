# LIFECYCLE-SERVER-INCARNATION mutants (Cloud, branch pr/lifecycle-server-incarnation-20261126)

STATUS: RUN 2026-11-26. Each mutant applied singly to the committed tree, then `tests/unit/project-lifecycle-routes.test.ts` (--maxWorkers=1), then reverted with `git checkout`. 5 of 5 killed.

S1 is the proof that the new test fails on cloud/next without the fix: it puts packages/cloud-server/src/project-lifecycle-routes.ts back to what cloud/next has (the member refused), and the two "a preview and an outcome that name the incarnation are answered (not 503)" tests fail.

| # | Location | Mutation | First failing test | Result |
|---|---|---|---|---|
| S1 | previewOk | the optional-member list loses `expectedProjectIncarnation` (= cloud/next before this lane) | "archive: a preview and an outcome that name the incarnation are answered (not 503)..." and the restore one | killed |
| S2 | previewOk | the incarnation is not type/range checked | "...a preview that is not a positive whole number ... is still refused" (archive and restore) | killed |
| S3 | previewOk | the member list also lets another unknown member through | same tests ("an unknown member") | killed |
| S4 | previewOk | 0 accepted (`whole(..., 0, MAX)`) | same tests ("0") | killed |
| S5 | previewOk | only `typeof number` checked (fractions accepted) | same tests ("a fraction") | killed |
