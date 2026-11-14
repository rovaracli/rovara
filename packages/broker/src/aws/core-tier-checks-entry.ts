// S3-9 (review H1c, M1): the CoreTierChecks function's own entry. It is NOT the broker: it loads no broker handler and answers one event, the lighter flow's tier pass (aws/broker/core-tier-checks.ts), with
// an explicit, small environment (infra/lib/core-tier-checks.ts): the State table and artifacts bucket names, the in-VPC model function's name, the GitHub App's key ARN and identity, and, where the model
// function makes long calls, TIER_REVIEW_ENABLED=1 (packed setting `tq`).
//
// The Cloud root it runs is built from the install's core inputs (`cloudCore`), the same inputs the broker's root needs. No production builder supplies them yet (DEFERRED S3-ENTRY-NEEDS: the broker
// has none either, so its root is not built and no core task starts). Until it does, a tier pass here is a misconfiguration and throws (its schedule is DISABLED while the core engine is off).
import "./broker-environment-init.js";
import { createCoreTierChecksHandler } from "./broker/core-tier-checks.js";

export const coreTierChecksHandler = createCoreTierChecksHandler(() => undefined);
