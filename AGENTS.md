# Rovara: notes for coding agents

Read this first. It is short on purpose. For "where does X live", go to [docs/architecture/code-map.md](docs/architecture/code-map.md).
`CLAUDE.md` imports this file, so Claude Code and Codex read the same text.

## Names: Rovara was called AgentX

The product is Rovara. Much of the code still uses the old name, so **search for both**:

- Packages are `@agentx/*` (for example `@agentx/contracts`). The CLI binary is `agentx`.
- Environment variables and settings use `AGENTX_*` (for example `AGENTX_SETTINGS`). MCP tools start with `agentx_`.
- Specs under `specs/` (`001-agentx-foundation` and on) are historical. They describe what was built at the time.
  Some numbers repeat (two `008-*` and two `025-*`). Trust the code and `docs/architecture/code-map.md` over a spec.

## Layout

| Path | What it is |
|---|---|
| `packages/broker` | The control plane: one AWS Lambda that answers the web app, Slack, GitHub and workers. Most changes land here. |
| `packages/worker` | Runs a task on an EC2 worker: checkout, agent run, checks, report back to the broker. |
| `packages/contracts` | Shared types and schemas (zod) used by every package. The barrel is `src/index.ts`. |
| `packages/web`, `packages/ui` | The web app (`/app`): `web` is the shell and build, `ui` holds the pages and components. |
| `packages/cli` | The `agentx` command (install, upgrade, project setup). |
| `packages/slack-service`, `gateway`, `mcp`, `orchestrator`, `model-proxy`, `model-runtime` | Smaller services. See each package's `src/`. |
| `packages/verifier`, `audit-verifier` | Check verification and the audit ledger's verifier. |
| `infra/` | AWS CDK app (`infra/bin`, stacks and constructs in `infra/lib`). |
| `tests/` | `unit`, `contract`, `integration`, `e2e`, `web`, `web-e2e`, `live`, `staging` and more. Tests are grouped by kind, not by package. |
| `scripts/` | Repo scripts: lint shards, typecheck baseline, release, preflight. |
| `docs/` | User and operator docs. `docs/development.md` covers local validation in more depth. |

## Commands

The Node version is pinned in `.node-version` (22.23.2). The contract and E2E tests expect exactly that version.

```sh
npm run typecheck                                   # tsc -b (build first: lint and tests read built declarations)
npm run typecheck:changed                           # typecheck baseline, only files you changed
npx vitest run <test files> --maxWorkers=<n>        # focused tests; run the files your change touches
npx eslint <changed files>                          # lint only what you changed
node scripts/lint-shards.ts --only <shard>          # one lint shard (`--list` names them)
```

- Don't run the whole suite, `npm run lint` or `typecheck:all` locally unless your brief asks. CI runs them at merge.
- If vitest can't resolve `@agentx/contracts`, its `dist` is stale: run `npx tsc -b packages/contracts`.
- Machine-specific rules for the owner's Mac (the heavy-command lock, worker counts, which gates to run) are in the
  task checklist your brief names. That file is the authority on gates. This file is not.

## Shell traps (macOS, zsh)

- **Quote globs.** zsh aborts `grep -rn foo --include=*.ts` with `no matches found`. That looks like "no results" but
  isn't. Write `--include='*.ts'`, or use `git grep -n foo -- '*.ts'` or the Grep tool.
- macOS `sed -i` needs an argument: `sed -i '' 's/a/b/' file`.
- There is no `timeout` command on macOS by default.

## Conventions that save time

- **Feature switches** are two-letter codes (`rd`, `ak`, `vx`, `nh`, ...). The whole list, with what each does, is
  `BROKER_SETTINGS` in `packages/contracts/src/broker-names.ts`. Search there for `code: "xx"`.
- Big files were split by feature. `packages/broker/src/aws/broker.ts`, `developer-tasks.ts` and
  `developer-routes.ts` are now entry files of a few hundred lines. The code is in the folders with the same names.
  Most files in `aws/broker/` and `aws/developer-routes/` begin with a comment saying what they own. The ownership
  tables in `docs/architecture/code-map.md` collect them.
- A new contract file, broker read or route usually needs an inventory test updated. See the recipes in
  `docs/architecture/code-map.md`. The changed-file gates do not catch these.
- Never put real-looking keys or tokens in fixtures. The public repo's push protection refuses them. Build fake
  tokens at runtime.

## Keep this file true

If something here is wrong, fix it in the same change that proves it wrong. Keep it short: link to docs instead of
copying them.
