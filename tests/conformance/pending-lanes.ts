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
