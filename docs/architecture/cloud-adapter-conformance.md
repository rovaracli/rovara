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

Ports covered today: document-store, queue, outbox, object-storage, secret-store, worker-machines, scheduler, image-registry, admission, audit-sink, approvers, identity, metering, model-key-store,
code-host, check-runner, tracker. `github-client-conformance.ts` is exempt (it tests Code's own GitHub client, not a port a Cloud adapter implements). A suite for a new port (the plan's K1 lane) is
added to `ports.ts` (suite, harness type, vendored file name), `code-fakes.ts` (its positive control) and `pending-lanes.ts`.

## Registered adapters

- `approvers` and `identity` (lane A6 `cloud/people`): `packages/broker/src/cloud/adapters/people/`, harnesses in `tests/conformance/adapters/approvers-cloud.ts` and `identity-cloud.ts` over the in-memory DynamoDB fake
  (`tests/support/cloud-people-world.ts`). They wrap Cloud's approval-place rule, decide-grade step-up, Slack press resolution, second-person rule and the routes' authentication with no rule of their own;
  `tests/unit/cloud-people-equivalence.test.ts` checks them against today's code case by case. What the ports cannot say yet is in `gaps.ts` (owed upstream, dated).
