# Rovara task checklist

The one list of what to run and what to check before you report a task DONE. Reviewers use it as their first pass.
In your report, say how you checked each item, or why it doesn't apply.

Rules about one machine (the heavy-command lock, worker counts, Node paths) are not here. They are in the machine
rules your brief names. On the owner's Mac that is `~/.local/share/rovara-tools/mac-rules.md`, and the copy in your
worktree's `.superpowers/sdd/rovara-task-checklist.md` has both files joined.

## 1. What to run before you hand off

- **Affected tests only:** the test files for the code you changed, plus their neighbours. Never the whole suite.
- **Typecheck:** `tsc -b` on the touched packages. Then the strict typecheck of every `tsconfig.lint/` shard that
  holds a changed file: `npx tsc -p tsconfig.lint/<shard>.json --noEmit`. Run `tsc -b` first, because without built
  project references the shard check falsely reports 0 errors. Judge it by the exit code and the total `error TS`
  count, never by grepping for your file names.
- **Lint:** eslint on the files you changed. Not `npm run lint` and not `npx eslint .`.
- **UI changes:** Chromium-only browser tests for the touched journeys, plus screenshots.
- **Inventory tests**, when you add broker functions that read task data, lifecycle steps, or contract files the web
  app imports. Changed-file gates miss these:
  - `tests/contract/task-owner-reads.test.ts`
  - `tests/contract/agent-lifecycle.test.ts`
  - `tests/contract/contracts-web-entry.test.ts` (the `packages/cloud-contracts/web-safe-files.json` list)
- **After you rename, move or delete a file or an exported function:** run `node scripts/codemap.ts` (about one
  second, no heavy.sh needed). It fails if `docs/architecture/code-map.md`, `AGENTS.md` or this file still names the
  old one; fix the doc in the same change. CI runs the same check as `tests/unit/codemap.test.ts`.
- **After merging an integration head into your branch:** run `npm run typecheck:all` once. Changes on the two sides
  can break a file neither side touched.
- **Mutation tests** (break the guard, see a test fail) only for money and auth guards, once before release.

The full suite, `typecheck:all`, all lint shards and all three browsers run once on CI when the controller merges.
After a CI failure, re-run only the failed files and the tests around the fix.

## 2. Tests

- **A test must fail without the fix.** Write it first and see it fail. A test that passes on the old code proves nothing.
- **Positive controls:** a "nothing leaked" test must also prove the leak path actually ran.
- **Check each case's own result** (its account, session, outcome), not just counts.
- **No absolute machine paths** in tests (`/private/tmp/...`, `/Users/...`): they break Linux CI. Use `mkdtemp(tmpdir())`,
  `testInfo.outputPath()`, or for browser screenshots `tests/web-e2e/support/screenshot.ts#evidenceShot`. Check with `git grep -nE '"/(private/tmp|Users)/' -- tests`.
- No shared fixed ports, global Docker label checks or order dependence. Serialize files that share resources.

## 3. Credentials never reach evidence

- Trace every secret your change touches (passwords, emails and their local part, cookies, tokens, local storage, seed
  files, provider keys) to every place it could land: screenshots, raw reports, display rows, logs (worker CloudWatch
  lines included), build logs, Slack, DynamoDB, S3, error messages.
- Assume encodings: raw, percent-encoded (single and double), base64, base64url, hex, JSON-escaped.
- Free text from errors (model errors, git, command output, file paths) is user content. Never log or store it; use
  fixed codes from an allow-list.
- Short or common values (`1`, `true`, `en-US`) must not be treated as secrets: they corrupt reports.
- Never put real-looking keys or tokens in fixtures. The public repo's push protection refuses them. Build fakes at runtime.

## 4. Data and DynamoDB

- **Same transaction.** Every side record (idempotency or request item, audit pending item, counter, index item, event)
  is written in the same transaction as the change it belongs to. A transaction holds at most 100 items: count them,
  and refuse inputs that would exceed that.
- **Replay.** A repeat of the same requestId returns the stored outcome and writes nothing. The same id with a
  different body is refused (CONFIG_INVALID). A late replay after the opposite action changes nothing. Request items expire.
- **Conditions on what you read.** Every write that depends on a value you read is conditional on that value
  (revision, status, version, owner, budget). A lost race gives a clear conflict, never a silent overwrite. Read the
  item again before deciding the outcome: a TransactionCanceledException can mean the write succeeded.
- **Existing data keeps working.** Anything stored before your change (proposals, approvals, policy digests, registry
  rows, receipts, display records) must still parse, verify and dispatch, or fail with a clear "propose/approve again"
  message. Add a test that builds the stored object exactly as the previous code wrote it.
- **Changed digests or pins:** list each one and say why. Prefer designs that don't move them.
- **Mixed fleets:** an older worker must be refused cleanly at dispatch (a worker feature string), never mis-run.

## 5. Access and boundaries

- **Tenancy.** Every key is built from the caller's checked org. A cross-org id gives 404, the same as a missing id.
  Test it with a second org on every route.
- **Nothing learned below view.** Lists, counts, error texts and replays never reveal items the caller can't view.
  Error messages never echo client-supplied keys or names.
- **Live data, not cached.** Roles, guardrails and connection state are re-read on each request.
- **Validate at every boundary,** not just the route: stores, backfills, syncs and internal callers too (ids, sizes,
  control characters `\p{Cc}\p{Cf}`, code-point lengths).
- **Untrusted output.** Anything shown in a terminal or page is neutralised: escaping, `[U+XXXX]` markers, length caps.
- **IAM.** Minimum actions on exact ARNs, no wildcards. Report the size of any broker policy group you grow.

## 6. Fail closed, bounded

- Unreadable, malformed or missing input refuses or gives UNKNOWN, never PASS. A failed lookup, timeout or 5xx
  refuses or gives a retryable 503; it never lets the action through.
- Every wait and retry has a bound. Transient AWS faults retry (bounded); deterministic refusals are final, with a
  specific reason.
- **Partial failure:** for each multi-step flow, ask what happens if the process dies between two steps, and make sure
  something repairs it (a retry, a scheduled reconcile, or a single transaction).
- Informational work (baselines, previews) never sets a verdict, blocks publication or spends another task's budget.

## 7. Linux is not macOS

- CI and the EC2 workers run Linux: GNU coreutils, Docker 25 on the worker, 128 KiB per environment variable, real
  network walls. A macOS pass can hide a bug.
- Shell code must work with GNU `head`, `dd`, `grep`, `sed` and `wc`.
- Containers have a read-only root, no HOME and no network. npm and other tools may try to write or phone home.
- CI's `linux-runtime` job is the Linux gate. Read its result before calling a task done.

## 8. Merge hygiene

- Keep edits in shared entry files (`packages/broker/src/aws/broker.ts`, `developer-tasks.ts`, `developer-routes.ts`,
  the contracts barrel, `.github/workflows/ci.yml`, `eslint.config.js`) to small, one-line wiring. Put the code in the
  split modules (`docs/architecture/code-map.md` says which).
- A new Lambda setting goes through the shared naming module (`packages/cloud-contracts/src/derived-names.ts`) or the packed
  settings in `packages/cloud-contracts/src/broker-names.ts`. Keep `tests/contract/lambda-environment-size.test.ts` headroom.
- New fixture directories need an eslint ignore.

## 9. Never

- Never close, cancel or change the owner's tasks, workspaces or pull requests.
- Never touch production or the release pipeline.
- Never push to `origin` (the public repo) from a private branch.
- Never dispatch subagents unless your brief says you are a controller.
