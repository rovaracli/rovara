# Task 35a: CLI and MCP for the agent platform (part 1)

## Status

**Done.** Branch `feat/agents-35a`, cut from `53ce7170` (`feat/agents-plan3`).

## Commits

| Commit | What |
|---|---|
| `d8e3a45` | `test(cli,mcp): agents, approvals and spend commands and tools, failing first` (the RED tests) |
| `13e819c` | `feat(cli,mcp): build, run and govern agents from the command line` (the implementation, plus updates to existing tests that pin exact command and tool lists) |
| (this file) | `docs: Task 35a report` |

## RED evidence

The new test files were written and committed (`d8e3a45`) before any implementation. The run was:

```
npx vitest run tests/contract/cli-agents.test.ts tests/contract/cli-spend.test.ts tests/contract/mcp-agent-tools.test.ts --maxWorkers=2
 Test Files  3 failed (3)
      Tests  40 failed | 10 passed (50)
```

All 40 behaviour tests failed: the commands and tools did not exist, so commander rejected them, and the MCP tool list and client methods were missing.

The 10 that passed are refusal checks. They assert a non-zero exit and that no request was sent, and an unknown command satisfies both. They pass now for the right reason, and are paired with positive tests on the same commands.

One fixture fix was made before the RED commit: an invalid `RunContextItem.kind` (`url`, changed to `alert`). The log was kept locally as `review-out/task-35a-red.log`; `*.log` is gitignored, so it isn't committed.

## Tests and counts (GREEN)

| File | Tests |
|---|---|
| `tests/contract/cli-agents.test.ts` (new) | 34 pass |
| `tests/contract/cli-spend.test.ts` (new) | 7 pass |
| `tests/contract/mcp-agent-tools.test.ts` (new) | 9 pass |
| `tests/support/agents-cli-harness.ts` (new) | `routeFetch`-based fake control plane that records each request's method, path, query and body |

These cover every Step 1 point:
- `draft set` sends `expectedRevision` taken from the GET.
- A 409 exits 1 and prints the broker's exact message.
- `run --draft` sends `version: "draft"`.
- `org sources add` refuses `--key`.
- `approvals show` prints the full arguments.
- `approvals open` prints the `confirmUrl` and sends no decision.
- The CLI has no approve, decline or deny command.
- No MCP tool decides anything, and `agentx_list_approvals` returns `confirm_url`.
- The start tools pass `agent` and `input` through.
- `agents budget` answered 202 prints the message and request id, and exits 0.

**Wider run (named files only, `--maxWorkers=2`):** every `tests/contract` file whose name matches cli or mcp (61 files): **1311 passed, 4 failed**.

All 4 failures are in `tests/contract/init-cli.test.ts` ("a source-built agentx with --engine cdk --source"). They fail identically on the base commit `53ce7170` with my changes stashed, so they are **pre-existing and unrelated**.

**Existing tests updated** because they pin exact lists:
- `cli-main.test.ts`: top-level commands, plus `org` and `project` subcommands.
- `mcp-tools.test.ts`: the tool list.
- `mcp-stdio.test.ts`, `mcp-admin-session.test.ts`, `tests/support/mcp-broker-client.ts`: tool counts, 26 → 29 and 34 → 37.

**Checks:**
- `npx tsc -b` is clean.
- `eslint` on every changed file is clean.
- No golden fixtures changed.

## Commands built

Every command takes `--json` and calls the `/v1/app/*` routes. A refusal prints the broker's message as is: `ReportedFailure` with the broker's code. A 409 exits 1; other refusals use the code's exit. A change that waits on the confirmation page prints its `confirmUrl` and exits 0.

**CLI: `agents`** (`packages/cli/src/developer/agents.ts`)
- `list [--mine|--shared|--builtin] [--project <p>]`
- `show <id>`
- `create --name <n> [--description] [--extends <id>] [--project-owner <p> --accountable <email-or-id>]`
  - The person is resolved through `GET /v1/app/org/members`.
- `draft get <id>`
- `draft set <id> --file <overlay.json>`: GETs the draft first and sends its revision as `expectedRevision`.
- `publish <id> [--note]`: the revision comes from the draft.
- `versions <id>`
- `diff <id> <from> <to>`
- `rollback <id> <version>`
- `update-base <id>`: the revision comes from the draft.
- `adopt <builtinId> <version>`
- `share <id> --file <shares.json>`
- `archive <id>`, `unarchive <id>`
- `accountable <id> <email-or-id>`
- `budget <id> [--monthly <usd|none>] [--max-per-run <usd|none>]` (in `spend.ts`)
- `run <id> --project <p> --input <text> [--draft] [--version <n>]`

**CLI: projects**
- `project agents add|remove <project> <agentId>`
- `project connectors list <project>`
- `project connectors set <project> <name> --file <connector.json>`: the revision comes from the list.
- `project connectors remove <project> <name>`: the revision comes from the list.
- `project connectors comment-triggers show <project> <repository>`: prints the files the scan read and its digest.
- `project connectors comment-triggers opt-out <project> <repository> --reason <text>`: sends the scan's digest as `expectedDigest` and prints the confirmation link.
- `project ai set <project> [--budget <usd|none>] [--project-pays on|off] [--planning-quick <usd>] [--planning-full <usd>]` (in `spend.ts`)

**CLI: skills, approvals and org**
- `skills add --file SKILL.md`, `skills list`
- `approvals list`
- `approvals show <id>`: prints the full arguments and the `confirmUrl`.
- `approvals open <id> [--no-browser]`: calls `POST /v1/app/approvals/{id}/confirm-link`, as the 21a-wiring hand-off says. It prints the link and opens it in the browser (or only prints it), and never calls `/decide`.
- `org comment-triggers list`: the existing Task 14b command, reused unchanged and covered by a smoke test.
- `org guardrails show`
- `org guardrails set --file`: reads the revision first.
- `org sources list`, `remove <id>`, `order <id...>`, `check <id>`
- `org sources add --file <source.json> [--key-from-env <VAR>]`
  - A `--key` flag is refused before anything is read or sent.
  - The key is sent once and never printed.

`connections` (Task 12b) and `org comment-triggers list` (Task 14b) were reused, not duplicated.

**R66: the CLI never decides.**
- There is no approve, decline, deny or decide command for agent approvals, spend or opt-outs, and a test walks the whole command tree to check this.
- The only names it finds are the operator's existing `admin egress approve` and `admin egress reject`. Those predate the agent platform and use the admin sign-in. The test names them explicitly so that any new decide command fails it.

**MCP** (`packages/mcp/src/tools.ts`, `client.ts`)
- `agentx_start_task` and `agentx_start_workflow` gain:
  - `agent: { agent_id, version? }`
  - `input: { context? }`
  - The input's `text` is the instructions, as the contract requires. Both are part of the request-id content, so a retry stays the same request.
- **`agentx_list_agents`**: `GET /v1/app/agents[?project=]`.
- **`agentx_run_agent`**: `POST /v1/app/agents/{id}/runs`. It returns the task, so the existing get and wait tools work on it.
- **`agentx_list_approvals`**: for each pending approval (up to 10), it reads the approval with its full arguments, then calls `POST …/confirm-link`. It returns `summary`, `arguments` and `confirm_url` (`<cell>/v1/app/approve/<id>`, ticketed when the person may decide it).
  - Its description says the assistant cannot approve, and must give the person the link.
- No tool and no client method decides a write approval, a step or chain-gate approval, a spend request or an opt-out. Tests check both the tool names and the client's methods.

## Left for part 2 (no stubs written)

- `spend-requests list|open`
- `agents spend`
- `org spend [--month] [--ledger]`
- `task continue-as-task`

## Route gaps and notes

1. **The `--version` clash.**
   - **Problem:** the program's own `-V, --version` (commander's version flag) is parsed anywhere on the command line, so `agentx agents run <id> --version 2` would print the CLI's version and exit.
   - **Fix:** `executeCli` hands `--version <n>`, only after `agents run`, to a hidden `--run-version` option. The handover is `agentRunVersionArgv`, which skips the program's options that take values, such as `--env staging`. A test covers it with `--env staging` in front.
   - Every other `--version` is unchanged.
2. **The budget 202 has no body contract yet.** `PUT /v1/app/agents/{id}/budget` does not answer 202 at `53ce7170`; Task 32 adds the owner-cap request.
   - The CLI already handles a 202 with `{ message, requestId | spendRequestId }`: it prints both and exits 0. A `NEEDS_CONFIRMATION` 202 prints the link.
   - Task 32 should confirm the body shape.
3. **"Post nothing" versus `confirm-link`.** The brief says `approvals open` "posts nothing", but the binding controller addition and the 21a-wiring hand-off say it calls `POST …/confirm-link`.
   - I followed the controller. `open` makes exactly that one bodiless POST and never touches `/decide`, and the test asserts both.
   - `agentx_list_approvals` makes the same call for each approval, so each call can mint a ticket. The MCP client sends a bodiless POST once (no retry), and the tool limits itself to 10 approvals.
4. **`asm-exec` is not in this repository.** `--key-from-env <VAR>` reads the named environment variable, which a wrapper such as `asm-exec` is expected to set. The CLI never calls `asm-exec` itself.
   - A `processEnv` dependency was added to `CliDependencies` so tests can supply the environment.
5. **`comment-triggers opt-out` requires `--reason`.** The brief shows it as `[--reason <text>]`, but `CommentTriggerOptOutRequestSchema` requires a non-empty reason. The CLI refuses without one, before sending anything.
6. **`agents spend` and `org spend` routes exist already.** `GET /v1/app/agents/{id}/spend`, `/v1/app/org/spend` and its ledger are on `53ce7170` (Task 30). They were left for part 2 as instructed.

## Fix round 1

This round answers `review-out/task-35a-review.md` on `review/task-35a-review` (head `cabe3756` reviewed). The tests were written first.

**RED run** (`tests/contract/cli-agents.test.ts`, `cli-spend.test.ts`, `mcp-agent-tools.test.ts`, `--maxWorkers=2`, before any source change): 3 files failed, **17 failed | 49 passed (66)**. The failures were the new tests for I1 (three), M3, M4, M5, M7, M9, M11, M12, M13, M14, M2 (three: the list mints nothing, the new tool, and its description), the R3-4 tool-name list (which now includes `agentx_open_approval`) and M10. The M1 fixture passed before the change too, because `requestedText` already read `spendRequestId`.

**GREEN run:** `npx tsc -b` is clean. ESLint is clean on the changed files. Ten files pass with `--maxWorkers=2`, **254/254**: `cli-agents`, `cli-spend`, `mcp-agent-tools`, `cli-main`, `mcp-admin-session`, `mcp-stdio`, `mcp-tools`, `connections-cli`, `developer-cli` and `comment-triggers`.

### What changed

- **I1 (Important), fixed.**
  - `clean` in `packages/cli/src/developer/agents.ts` (exported, and used by `spend.ts`) is now `terminalSafe` applied after the `agx[rc]_` token redaction.
  - `str`, `item`, `waitingText`, the approvals output and the `appRequest` error message all go through it. RLO, `U+009B`, `U+200B`, other Cf and C1 characters, and line separators now print as `[U+XXXX]`.
  - New tests put RLO, `U+009B` and `U+200B` in an approval's summary, prompt and changes (`approvals list` and `show`), and in a 409 message along with a refresh token. They assert the markers, that no raw character is left, and `[hidden]`.
- **M1, fixed.** The cli-spend 202 fixture is now `{ status: "NEEDS_ADMIN_APPROVAL", spendRequestId, message }`, with a comment marking it as pinning a Task 32 shape (the broker's "TASK 32 SEAM").
- **M2, fixed.**
  - `agentx_list_approvals` returns the approval's bare `confirmUrl` from `getApproval` and mints no ticket.
  - New tool `agentx_open_approval(approval_id)`: it checks the ID against `ApprovalIdSchema`, then makes one `POST /v1/app/approvals/{id}/confirm-link`. Its description says the link is for the person and must not be fetched or opened by the assistant, since that would spend the single-use ticket.
  - Tests cover: the list makes no confirm-link call, the new tool calls it once, its description, and an invalid ID sending nothing.
  - The MCP tool counts in `mcp-tools`, `mcp-stdio` and `mcp-admin-session` went up by one: 29 to 30 developer tools, and 37 to 38 with admin.
- **M3, fixed.** `approvals open` hands the browser a link only when it is `https:`, has the cell's own origin, and has a path under `/v1/app/approve/`. Any other link is printed with a note and never opened.
- **M4, fixed.** `org sources add` strips the key from the answer before printing, in both text and `--json`.
- **M5, fixed.** The "not set" message repeats the variable's name only when it looks like one (`^[A-Z_][A-Z0-9_]{0,63}$`).
- **M7, fixed.** Every path segment refuses `.` and `..` before anything is sent, in `spend.ts` as well.
- **M8, fixed** through I1: long text is cut at 500 characters and ends with `...[truncated]`.
- **M9, fixed.** `agentRunVersionArgv` also rewrites `--version=<n>` after `agents run`.
- **M10, fixed.** With an agent or an input, instructions over 8,192 bytes are refused with "instructions: with an agent or an input, instructions are at most 8,192 bytes".
- **M11, fixed.** `--planning-quick` and `--planning-full` take `none`, which sends `null` and resets the limit to the default.
- **M12, fixed.** `project connectors set` fills in `name` from the argument. A file naming another connector is refused before anything is sent. The existing test's expected body now includes `name`.
- **M13, fixed.** A 202 `EXECUTING` answer prints "being applied; check it with agentx project connectors list <project>".
- **M14, fixed.** `draft get` names the agent from its argument.
- **M15, fixed.** The `kind`, `status`, `project`, `connector` and `tool` fields of `agentx_list_approvals`, and the `status` and `access` fields of `agentx_list_agents`, now go through `plainText`.
- **M17, fixed.** The descriptions of `project connectors` and the top-level `connector` command now point to each other.
- **M6 and M16, not changed.** Both are questions for the plan owner:
  - M6: the CLI reads `--key-from-env` and does not call `asm-exec` itself.
  - M16: whether R66's "step approvals" excludes native workflow plan gates on agent-backed workflows.
