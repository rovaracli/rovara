// Test services, slice 1: the one place the orchestrator (test-services-run.ts) is bound to s1-sealed's two exports. Everything else takes them as `SealedRoundPorts` (tests stub them).
import { withSealedCheckRound } from "./check-round-runners.js";
import { buildServiceUsageRecord } from "./service-usage-record.js";
import type { SealedRoundPorts } from "./test-services-run.js";

export const SEALED_ROUND_PORTS: SealedRoundPorts = { withSealedCheckRound, buildServiceUsageRecord };
