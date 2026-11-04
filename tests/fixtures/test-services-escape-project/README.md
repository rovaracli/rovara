# Test services escape project

A project for the staging done-check of Rovara test services (slice 1). Its **tests try to escape** the sealed check round and assert that every attempt fails, so a passing run is the proof, and it comes back through the task's normal evidence (no shell on the worker is needed). Nothing here passes on nothing: a missing heartbeat, a missing plant receipt, a failed lookup, or no address to probe is a FAILURE.

## Settings of the staging project that uses it

- one dependency: Postgres 16 (`DATABASE_URL`), seeded by `npm run seed` (creates one table, `seeded_in_round`)
- checks, one per test file (so the evidence names each by its command, and the done-check ties its verdict to these names):
  - `node --test tests/internet.test.js`
  - `node --test tests/ipv6.test.js`
  - `node --test tests/neighbours.test.js`
  - `node --test tests/planted-state.test.js`
  - `node --test tests/relay.test.js`
- setup command: `npm run setup` (optional: the task prompt below also asks for it)

## What makes the working phase happen (the done-check does this)

The sealed round can only prove what the working phase left behind if the working phase did something. `scripts/staging-test-services-e2e.sh --escape-project <name>` starts an IMPLEMENT task whose prompt is:

> Run `npm run plant` and then `npm run setup` in the terminal; both must print a line starting with OK. Then add one line to README.md that says the escape project ran. Change nothing else.

- `npm run plant` (tools/plant.js) creates `planted_escape` and `escape_planted.planted_escape_other` in the **working-phase** Postgres and, if the role may, `ALTER SYSTEM SET escape.marker`. It reads them back (a plant that did not take fails), and writes `.escape-plant.json`.
- `npm run setup` (tools/start-heartbeat.js) leaves a detached process in the working sandbox that **listens on a port** of the working sandbox's address and rewrites `.escape-heartbeat.json` (counter and timestamp) every 200 ms. It fails if the heartbeat does not come up.

Only an IMPLEMENT task has a working-phase Postgres (CHECKS runs and Prove start none), so a CHECKS-only run cannot plant, and the sealed tests fail on the missing receipt.

## The tests

| test file | what it tries | passes when |
|---|---|---|
| `internet.test.js` | TCP to public IPv4 addresses; two public/unknown names | every connection fails; both names resolve to **exactly the sinkhole's address** (the round's own resolver answers every unknown name with it) inside the run's network; the positive control (the round's own dependency name resolves to a helper in the run's network, not the sinkhole) holds |
| `ipv6.test.js` | TCP to a public IPv6 address; the interfaces | the connection fails; no global IPv6 address is configured |
| `neighbours.test.js` | the gateway (.1), the .3 address, the metadata address; the working sandbox's **listening heartbeat** at its recorded address | no connection, and for the gateway, .3 and the heartbeat **no refusal either** (a reset means something answered); the run's own Postgres IS reachable (positive control) |
| `planted-state.test.js` | the receipt of the working-phase plant; every non-system table and schema in the run's Postgres; the planted setting | the receipt exists; the database holds exactly `public.seeded_in_round`, no `escape*` schema, no `escape.marker` |
| `relay.test.js` | the heartbeat's state file | liveness control: it ticked at least 5 times and its last tick is recent (a dead heartbeat FAILS); and the file does not change for 1.5 s while the round runs (the working sandbox is frozen) |

## Overrides (fixture tests only)

Each target can be replaced with an `ESCAPE_*` variable (see `lib/targets.js`, `lib/resolve.js`, `lib/state.js`) so the repository's own tests can aim a test at something reachable and check that it then FAILS (tests/contract/test-services-escape-project.test.ts). They are honoured **only when `ESCAPE_FIXTURE_TEST=1`** (`lib/fixture.js`); in a real round they do nothing.

Not covered here, because they need privileges the check sandbox does not have: spoofed source addresses (TS-SEAL-4) and raw multicast; those stay Linux checks (linux-runtime CI).

## Slice 2: the `aws/` overlay (Rovara local AWS)

`aws/` holds what the slice-2 staging proof adds. It is **not part of the slice-1 project** (so slice 1 is unchanged); copy it over the project root for the slice-2 staging project: `cp -R aws/. .` and then `rm -rf variants`. It mirrors the project layout:

- `template.yaml`: a CloudFormation file declaring a DynamoDB table (`orders`), an S3 bucket (`orders-archive`) and an SQS queue (`order-events`). Setup finds them, so the project's environment lists Postgres plus S3, SQS and DynamoDB, and the worker seeds them into Rovara local AWS from this file. Nothing is deployed.
- `lib/aws-http.js`: plain HTTP calls to the emulator (no SDK). The endpoint is the run's `AWS_ENDPOINT_URL_S3`.
- checks, one per file, added to the slice-1 five (the done-check ties its verdict to these names):
  - `node --test tests/aws-positive.test.js`
  - `node --test tests/aws-control.test.js`

| test file | what it tries | passes when |
|---|---|---|
| `aws-positive.test.js` | stores and reads back an S3 object in the declared bucket; asks SQS for the declared queue; describes the declared DynamoDB table | all three answer 200 (so the emulator is there and the worker seeded the project's template) |
| `aws-control.test.js` | the emulator's health path, then `/_rovara/ledger/summary`, `/_rovara/ledger`, `/_rovara/seed`, `/_rovara/reset` with no token, a made-up control token and a made-up bearer token | health answers 200 and every control call is refused with **403 or 401** (a 404, a 2xx or a dropped connection FAILS); a refusal carries no counters or resource names |

**The flag project** (the out-of-plan proof): a second staging project, set up from a copy of the slice-2 project **after** its environment was approved, with `cp -R aws/variants/out-of-plan/. .` added to the repository. `aws-out-of-plan.test.js` sends an SNS `Publish` to the endpoint in `AWS_ENDPOINT_URL_SNS` (what the SDK does; the run points it at the emulator, which has SNS switched off); it passes when the emulator refuses (4xx/5xx), and Rovara's evidence must then flag "The code called AWS services that are not in the plan" (the done-check reads that from the task). It is a separate project because the same call would fail Prove's dependency usage check, by design, in the project that proves clean.

Unverified against the real emulator: the request shapes above (unsigned, credential scope names the service) and whether a disabled service's refused call is recorded in the ledger. The first staging run settles both; every test fails closed.
