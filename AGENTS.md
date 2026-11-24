# Rovara Cloud: notes for coding agents

Read this first. It is short on purpose. `CLAUDE.md` imports this file, so Claude Code and Codex read the same text.

## What Cloud is

Rovara Cloud is an API layer: its own server (`packages/cloud-server`) and web app (`packages/web`, `packages/ui`)
in front of a separate Rovara Code install. People sign in through Code, and every route the app calls is answered
from Code's HTTP API as that person. Cloud runs no engine: no broker, worker, CLI or user pool of its own. Its infrastructure (`infra/`) is its stacks, their
release pipeline and the model gateway's stacks. A
feature the app needs that Code's API cannot do yet starts as a Rovara Code issue, not as engine code here.

## Names

- Packages are `@agentx/*` (for example `@agentx/contracts`) except `@rovara/cloud-server`, `@rovara/model-gateway` and `@rovara/audit-verifier`.
- `packages/contracts` still holds schemas of the Code engine it was copied from. Leave them until contracts is trimmed.

## Layout

| Path | What it is |
|---|---|
| `packages/model-gateway` | Cloud model gateway: signed task tokens, budget reservations, streaming provider transport, the product-AI route with its write-only product key store (`docs/model-gateway-product-ai.md`), the learning and answers routes for lessons and people's questions on the company's own key, or company-billed Rovara AI with signed exact prices and receipts (only configured exempt companies are free) (`docs/model-gateway-learning.md`), nightly upkeep's per-project cap (`src/upkeep-cap.ts`, `docs/model-gateway-spend-limits.md`) and Code's signed read of it (`GET /v1/service/companies/<company>/upkeep/<project>`, `src/upkeep-cap-read.ts`), the company's own Bedrock for its agents and its tests' product calls (`docs/model-gateway-bedrock-byo.md`, `src/product-bedrock.ts`), and its process (`src/main.ts` -> `src/process.ts`: `GATEWAY_MODE=serve` or `price-fetch`) with DynamoDB and Secrets Manager adapters on node built-ins only (`src/aws.ts`, `src/dynamo*.ts`, `src/secrets.ts`; the image holds no node_modules). Customer-source overages durably stop one company/source/route class (`src/source-stop.ts`, `SOURCESTOP#<source>#product` or `#agent`); the class-less `SOURCESTOP#<source>` retains the shared in-flight slot and any legacy stop blocking both classes; the interactive operator-only clear is `scripts/model-gateway-source-stop-clear.mjs` (explicit `--class product|agent|legacy`, preview, confirmation and who/when/why audit; see `docs/model-gateway-bedrock-byo.md`). The models one company's agents may use (`docs/model-gateway-offered-models.md`, `src/offered-models.ts`). Code's eval spend authority (`POST /v1/product/eval/authority`, `src/eval-authority.ts`, DEC 253k; in `docs/model-gateway-product-ai.md`). Code's eval monthly cap (`POST /v1/product/eval/cap`, `src/eval-cap.ts`, DEC 253q). Budgets are read from the Cloud company backend's Companies table (`src/company-caps.ts`). That includes each project's and each person's own monthly limit (`SPEND_LIMIT#PROJECT#<project>` and `SPEND_LIMIT#PERSON#<person>` items, written by Cloud's `spend-limits-routes.ts`; a missing item is the company default, an item that does not read refuses the call). `src/deploy.ts` names what the process reads. Its container image: `environments/model-gateway/Dockerfile`, built by `npm run gateway:image -- build` (context only: `-- context --out <dir>`). |
| `packages/cloud-server` | Sign-in through Code, sessions, CSRF, and the route table `src/routes.ts`. See its README. |
| `packages/web`, `packages/ui` | The web app (`/app`): `web` is the shell, build and page handler, `ui` holds the pages and components. |
| `packages/contracts` | Shared types and schemas (zod). Browser code imports `@agentx/contracts/web` only. |
| `packages/design-tokens`, `packages/audit-verifier` | The app's design tokens; the audit ledger's verifier (used by contracts). |
| `infra/` | CDK: `lib/cloud-web.ts` (Cloud: CloudFront, Lambda running `scripts/cloud-lambda.ts`, DynamoDB), `lib/cloud-app.ts` (Cloud's first address, a redirect, and the client secret), `lib/cloud-release-pipeline.ts`, `lib/model-gateway.ts` (the model gateway: Fargate behind HTTPS, its tables, keys and alarms; never deployed by the pipeline), `lib/app.ts` (`-c rovaraCloudApp=<env>` makes both stacks, `-c rovaraCloudPipeline=<env>`, or `-c rovaraModelGateway=<env>`). Deploy guide: `docs/rovara-cloud-install.md`. |
| `scripts/` | `cloud-server.ts` (Cloud's server entry, also `npm run cloud:local`), the web build helpers, lint shards, the typecheck baseline and CI helpers. |
| `tests/` | `unit` (cloud-server is `tests/unit/cloud-server.test.ts`), `contract` and `web`. |

## Commands

The Node version is pinned in `.node-version`.

```sh
npm run build                                       # tsc -b and the web app (tests read built declarations)
npm run typecheck:changed                           # typecheck baseline, only files you changed
npx vitest run <test files>                         # focused tests; run the files your change touches
npx eslint <changed files>                          # lint only what you changed
npm run infra:synth                                 # synthesize the Cloud stack and its pipeline
ROVARA_CODE_URL=<code api> ROVARA_CLIENT_SECRET_FILE=<file> npm run cloud:local
npm run fake-code                                   # a fake Rovara Code with canned data (contract v0), for building screens before Code serves a route
npm run contract:table                              # contract v0 (packages/contracts/src/code-contract-v0.ts) as markdown tables
npm run contract:drift -- check                     # Code's pinned contract snapshot against Cloud's strict schemas (refresh and rules: scripts/contract-drift.ts)
npm run build && npm run test:browser              # browser tests (Playwright, chromium) on the fake Code; first time: npx playwright install chromium; selectors live in tests/web/browser/pages
```

- If vitest can't resolve `@agentx/contracts`, its `dist` is stale: run `npx tsc -b packages/contracts`.

## Shell traps (macOS, zsh)

- **Quote globs.** zsh aborts `grep -rn foo --include=*.ts` with `no matches found`. Write `--include='*.ts'`, or use
  `git grep -n foo -- '*.ts'`.
- macOS `sed -i` needs an argument: `sed -i '' 's/a/b/' file`. There is no `timeout` command on macOS by default.

## Keep this file true

If something here is wrong, fix it in the same change that proves it wrong.
