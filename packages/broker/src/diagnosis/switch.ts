// Live interaction F2: the Fix with agent switch and the key its context tags are derived from. A leaf module (no broker imports), so the route wiring and the service wiring can both use it.
import { createHmac } from "node:crypto";
import { liveInteractionFlagOn } from "@rovara-code/contracts";

/** Whether the switch is on in this environment: `LIVE_FIX_ENABLED` is exactly "1" (the packed setting `fd`). Anything else is off. */
export const diagnosisEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env["LIVE_FIX_ENABLED"]);

/** The key the context's tag ids are derived from: a server secret (the session cursor key, itself derived from the broker's signing key) under its own label. Never logged. */
export const diagnosisTagKeyOf = (serverSecret: string): string => createHmac("sha256", serverSecret).update("agentx:diagnosis-tag:v1").digest("hex");
