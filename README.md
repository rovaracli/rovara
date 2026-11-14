# Rovara Cloud

Rovara Cloud is the hosted web app for [Rovara Code](https://github.com/PrepLabsAI/Rovara). It is an
API layer only: its own server and web app, in front of a separate Rovara Code install. Cloud runs
no engine of its own. Every task, plan, check and pull request lives in Code, and Cloud reads and
changes them through Code's HTTP API as the signed-in person.

```
browser ──► Cloud (packages/cloud-server + the web app) ──► Rovara Code's API
```

- **Sign-in:** people sign in through Code (single sign-on). Cloud is Code's sign-in client
  `rovara-cloud`. Code's tokens stay on Cloud's server; the browser holds only a session cookie.
- **The app's API:** each `/v1/app/*` route in `packages/cloud-server/src/routes.ts` answers from
  Code, in the shape the web app reads. A route Code cannot answer yet returns 501 `NOT_ON_CODE_YET`.

## Layout

| Path | What it is |
|---|---|
| `packages/cloud-server` | Cloud's server: sign-in through Code, sessions, and the app's API answered from Code. Node built-ins only. |
| `packages/web` | The web app's shell and build (Vite), and the handler that serves its pages (`src/server/handler.js`). |
| `packages/ui` | The web app's pages and components. |
| `packages/contracts` | Shared types and schemas (zod). The web app imports `@agentx/contracts/web`. |
| `packages/design-tokens` | The web app's design tokens. |
| `packages/audit-verifier` | The audit ledger's offline verifier, which `contracts` uses. |
| `scripts/cloud-server.ts` | Runs Cloud against a Code install: on this computer (`npm run cloud:local`) and in its container. |
| `infra/` | Cloud's CDK app: the stack `rovara-cloud-<env>-app` (`infra/lib/cloud-app.ts`) and its release pipeline (`infra/lib/cloud-release-pipeline.ts`). |
| `environments/cloud/Dockerfile` | Cloud's container image (Fargate, linux/arm64). |
| `tests/` | `unit` (cloud-server), `contract` (contracts, audit verifier, repository checks) and `web` (the app). |

## Run it on this computer

You need Node.js 22 (`.node-version`) and a Rovara Code install that has the `rovara-cloud` client.

```sh
npm ci
npm run build
ROVARA_CODE_URL=https://<code api> ROVARA_CLIENT_SECRET_FILE=<file> npm run cloud:local
```

Then open http://127.0.0.1:8787/app. The options are in
[packages/cloud-server/README.md](packages/cloud-server/README.md).

## Deploy

Cloud deploys as one stack on top of an existing Rovara Code install, through a release pipeline: a
`vX.Y.Z` tag waits for a person to approve, then deploys. See
[Deploying Rovara Cloud](docs/rovara-cloud-install.md).

## Develop

```sh
npm run build          # Build every package and the web app
npm run typecheck      # Type-check the packages
npm run typecheck:all  # Also tests/ and scripts/, against tests/typecheck-baseline.json
npm run lint           # ESLint, in shards
npm test               # Vitest
npm run infra:synth    # Synthesize the Cloud stack and its pipeline
```

## Contributing and security

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see
[SECURITY.md](SECURITY.md).

## License

Licensed under the [MIT License](LICENSE). PrepLabsAI also preserves its prior Apache 2.0 grant for
PrepLabsAI-owned Rovara work, including earlier releases; see [RELICENSED.md](RELICENSED.md).
Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
&copy; 2026 PrepLabs
