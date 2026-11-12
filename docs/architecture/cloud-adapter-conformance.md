# Cloud adapters and Code's conformance suites

Cloud runs on Code's core, with private adapters on Code's ports (convergence plan, section 2). Code defines what an adapter must do as a conformance suite per port. Cloud does not copy or
rewrite those suites: it runs Code's own files against each Cloud adapter, so an adapter that passes here behaves the way Code's core expects.

## Where the suites come from

- `vendor/rovara-code/tests/support/ports/*-conformance.ts` are Code's suites at the pinned sha. `tests/support/ports` is in the vendor include list
  (`scripts/vendor/rovara-code-vendor.ts#INCLUDE`), so `node scripts/vendor/verify-rovara-code.ts --remote` (the first CI step) checks them byte for byte against the public tree. Never edit them here;
  change Code, then bump the pin (`vendor/README.md`).
- `tests/conformance/ports.ts` maps each port to its suite function and the harness type the suite takes. A suite that appears at a pin bump and is not wired there (or exempted with a reason) fails
  `tests/conformance/guards.test.ts`.

## What runs

`tests/conformance/conformance.test.ts` registers, for each port:

1. **Code's fakes and defaults**, the positive control (`tests/conformance/code-fakes.ts`). If one fails, the harness is broken, not an adapter.
2. **Every Cloud adapter** in `CLOUD_ADAPTERS` (`tests/conformance/adapters/index.ts`). A port with no Cloud adapter yet shows as a `todo` line naming the lane that owes it, never as a pass.

CI runs the target twice: once in the `checks` job right after `npm run typecheck` (so a broken adapter stops the run before the six shards start), and again in the test shards with the rest of `tests/`
(`vitest.config.ts` includes `tests/**`). It takes about ten seconds.

## Register an adapter (wave 1 lanes A1 to A9)

1. Write the adapter in `packages/cloud-adapters/<point>/` as the plan says. The conformance harness needs no AWS: build the adapter over a fake or local emulator of the service
   (an in-memory DynamoDB fake, a stub S3 client) and tear it down in `dispose`.
2. Add `tests/conformance/adapters/<port>-<name>.ts`:

   ```ts
   import { defineCloudAdapter } from "../registry.js";
   export const dynamoDocumentStore = defineCloudAdapter({
     port: "document-store",        // one of the keys of PortHarnesses in tests/conformance/ports.ts
     name: "DynamoDB",              // shown in test output as "Cloud: DynamoDB"
     harness: { async create() { /* a fresh, empty adapter, plus what the suite's harness type asks for */ } },
   });
   ```

   The harness type is the one Code's suite exports (for example `DocumentStoreHarness`), so a missing field is a type error. Look at the matching entry in `code-fakes.ts` for a working example.
3. Add the value to `CLOUD_ADAPTERS` in `tests/conformance/adapters/index.ts`. That is all: the suite runs on the next test run, and the port's `todo` line disappears.

For the plug-in contracts (`code-host`, `check-runner`, `tracker`) the harness is `{ makeWorld, skip? }`. A check the adapter cannot pass yet goes in `skip` by check name with the reason; it shows as
skipped in the report. There is no way to skip a whole port.

Registered so far: lane A3's model key store (`packages/broker/src/cloud-adapters/model-keys/`, install keys in Secrets Manager by ARN; its model-provider adapters for a company Bedrock role, the
model proxy and OpenRouter sit beside it and are checked by `tests/unit/cloud-adapters-models.test.ts`). They live in the broker until a `packages/cloud-adapters` package exists. The S3 objects and
Secrets Manager secrets adapters are public (Code's `@rovara/aws-adapters`, owner decision 72 O2) and are registered here after the vendor pin includes `packages/aws-adapters`.

Ports covered today: document-store, queue, outbox, object-storage, secret-store, worker-machines, scheduler, image-registry, admission, audit-sink, approvers, identity, metering, model-key-store,
code-host, check-runner, tracker. `github-client-conformance.ts` is exempt (it tests Code's own GitHub client, not a port a Cloud adapter implements). A suite for a new port (the plan's K1 lane) is
added to `ports.ts` (suite, harness type, vendored file name), `code-fakes.ts` (its positive control) and `pending-lanes.ts`.

## Queue and outbox (lane A2): owed after the pin carries `packages/aws-adapters`

Cloud's queue is Code's public SQS adapter (`@rovara/aws-adapters/sqs`), not a second copy, so the `queue` and `outbox` rows of `pending-lanes.ts` stay `todo` until the vendor `INCLUDE` list carries `packages/aws-adapters` and the pin is at a sha that has it. Then, register the two adapters as above: `queue` over the in-memory SQS double (`vendor/rovara-code/tests/support/ports/sqs-harness.ts`, both modes) and `outbox` over Cloud's DynamoDB store and that queue. Until then only Cloud's side is here: `packages/broker/src/cloud-adapters/queue/outbox-relay-wiring.ts` (the off switch and the install's one org) and the DISABLED `OutboxRelayBackstopSchedule` in `infra/lib/control-plane.ts`. Nothing installs the relay, so no message takes the new path (wave 1 is "no traffic").

## The money adapters (lane A5) and what S0 must do before they run

`packages/broker/src/cloud-adapters/money/` holds `CloudAdmission` (holds on the key ledger's own `ORG#<org>#SPEND#<month>` counters, `committedUsd`, with `ledger.ts#reserve`'s
room condition; one `ADMISSION_HOLD#` row per key; `enforcesCost: true`, decision 79) and `CloudMetering` (one `METER_ENTRY#` row per entry, `METER#<month>` totals in whole
millionths; an unpriced model, a $0 price or a provider-reported $0 is unknown, never $0). Both are inert: registered under Code's conformance suites, called by nothing.
The composition root (S0) must settle these before either is wired:

1. **One writer per model spend.** A model call that runs on a LiteLLM key is already counted by the key ledger's settlement (`spend/ledger.ts`, the proxy's figure, R22). Its
   admission must then be *released*, never settled, or the spend is counted twice on the same `SPEND#` counters. Decide per action which path counts it.
2. **Settle only from Metering's cost.** Where an admission is settled, the `cost` passed to `settle` is the `MeterResult.cost` of the same call (`CloudMetering.record`), never a
   caller's own figure; an unknown result settles with no cost, which charges the whole hold.
3. **The breakdown counters.** The key ledger's settle also adds to the agent, source, model and origin counters, `TASK_SPENT` and `AGENT_RUN` (`ledger.ts#extraCounters`,
   `settleOnce`). A spend counted by `CloudAdmission.settle` adds to the scope counters only: S0 must add the same breakdown in the settle's transaction, or the admin pages
   undercount.
4. **A single-call SPEND test.** One real model call end to end (admit, call, meter, settle or release) must move each `SPEND#` counter exactly once, by the call's cost, with the
   ledger and the adapter both live, before any switch goes on.
5. **Levels that repeat Cloud's rules.** `CloudAdmissionOptions.levels` must answer exactly the scopes `spend/payer.ts#budgetScopesFor` gives for the request's payer (org,
   project, member, agent, chain, testing) and the limits `spend/settings.ts#effectiveLimits` gives (base plus the month's top-up, no limit stays no limit), and `gate` must
   repeat the trial lock and machine-time admission (`org/trial.ts`). A test should compare the adapter's refusals with `admitWork`'s on the same rows.

Also owed: a schedule for `CloudAdmission.sweepExpiredHolds` (an expired hold is charged in full), and the `capacity` money cases of Code's admission conformance suite once
the vendor pin includes them (public `adapters/a5-money`).

## Slack on the channel point (lane A8, registered, no traffic)

`packages/broker/src/plugins/channel/slack-cloud/` is Cloud's Slack as an ordinary `channel` adapter on Code's port (`CloudSlackChannel`, `createCloudSlackSink`, `registerCloudSlackChannel`). Nothing live calls it: the Slack ingress, the Slack service and the notifier are
unchanged, and registering it posts nothing and reads no token. It sends with today's Web API calls and escaping; its sink takes the company from `SLACK_TEAM#<team>` and the person from the explicit-member rule (`slackRequesterStanding`, switch `sm`), passed in as `standingOf`.
The keys are the ones Cloud writes today (`ORG#<company>#SLACK_BINDING#<team>`); the only addition is the `ORG#<company>#CHANNEL_TENANTS` row Code lists bindings by, with a backfill and its reverse in `tenants-backfill.ts` (not run; owner gate G-DATA).
`tests/unit/cloud-slack-channel.test.ts` (characterization of today's behaviour, the adapter, the sink) and `tests/unit/cloud-slack-channel-keys.test.ts` (keys, isolation, backfill and reverse) are the checks.
The email (SES) and realtime (cloud events) adapters wait for the pin to carry Code's K1 ports (`email`, `realtime`): the pin bump also moves `pi-ai` to 1.5.2 in the worker and model-runtime, which is the controller's call.
