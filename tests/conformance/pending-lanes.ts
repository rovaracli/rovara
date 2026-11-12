// Which wave 1 lane of the convergence plan (section 4) owes each port's Cloud adapter. Only used for the "no adapter yet" lines of the test report.
import type { PortName } from "./ports.js";

export const PENDING_LANE: Readonly<Record<PortName, string>> = {
  "document-store": "lane A1 cloud/dynamo-store",
  queue: "lane A2 cloud/sqs-outbox",
  outbox: "lane A2 cloud/sqs-outbox",
  "object-storage": "lane A3 cloud/s3-secrets-models",
  "secret-store": "lane A3 cloud/s3-secrets-models",
  "model-key-store": "lane A3 cloud/s3-secrets-models",
  "worker-machines": "lane A4 cloud/ec2-machines",
  admission: "lane A5 cloud/money",
  metering: "lane A5 cloud/money",
  identity: "lane A6 cloud/people",
  approvers: "lane A6 cloud/people",
  "audit-sink": "lane A7 cloud/audit-sink",
  "code-host": "lane A9 cloud/hosts-trackers",
  "check-runner": "lane A9 cloud/hosts-trackers",
  tracker: "lane A9 cloud/hosts-trackers",
  scheduler: "no lane yet (a new point, plan section 2)",
  "image-registry": "no lane yet (a new point, plan section 2)",
};

/**
 * Lane A8: ports whose Cloud adapter is built and unit-tested but cannot be registered for Code's conformance suite yet, because the vendored pin does not carry the suite (K1 added `email-conformance.ts` and
 * `realtime-conformance.ts` after the pin). With the pin bump: add the two ports to `PortHarnesses`, `RUN_SUITE` and `code-fakes.ts` (`ports.ts`), register `SesEmailSender` and `AppSyncEventsPublisher` in
 * `tests/conformance/adapters/`, turn the `it.todo` lines in `tests/unit/cloud-email-ses.test.ts` and `cloud-realtime-appsync.test.ts` into that registration, import the ports from `@rovara-code/contracts`
 * (delete `packages/broker/src/cloud-adapters/k1-ports/`), and remove this list. `tests/unit/cloud-k1-port-mirror.test.ts` starts comparing the mirror with the real ports as soon as the pin has them.
 */
export const PENDING_AFTER_PIN: Readonly<Record<string, string>> = {
  email: "lane A8: Cloud's SES adapter (packages/broker/src/cloud-adapters/email-ses), waiting for Code's email-conformance.ts in the pin",
  realtime: "lane A8: Cloud's AppSync Events adapter (packages/broker/src/cloud-adapters/realtime-appsync), waiting for Code's realtime-conformance.ts in the pin",
};
