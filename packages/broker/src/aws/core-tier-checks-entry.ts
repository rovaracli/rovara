// S3-9 (review H1c, M1): the CoreTierChecks function's own entry. It is NOT the broker: it loads no broker handler and answers one event, the lighter flow's tier pass (aws/broker/core-tier-checks.ts), with
// an explicit, small environment (infra/lib/core-tier-checks.ts): the State table and artifacts bucket names, the in-VPC model function's name, the GitHub App's key ARN and identity, and, where the model
// function makes long calls, TIER_REVIEW_ENABLED=1 (packed setting `tq`).
//
// S3-10 (S3-9-TIER-CHECKS-HOST-INPUTS): the Cloud root it runs is built from the production inputs (cloud/app/entry-inputs.ts, cloud/app/core-host.ts) over this function's own clients, and only while the
// combined switch is on (packed setting `cc`): off, nothing is built and a tier pass is a misconfiguration that throws (its schedule is DISABLED while the core engine is off).
import "./broker-environment-init.js";
import { createCoreTierChecksHandler } from "./broker/core-tier-checks.js";
import { coreTierChecksProductionHost } from "./core-tier-checks-production.js";

export const coreTierChecksHandler = createCoreTierChecksHandler(() => coreTierChecksProductionHost(process.env));
