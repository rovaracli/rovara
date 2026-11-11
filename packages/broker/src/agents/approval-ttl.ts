// Plan 3 Task 21: how long a write approval and a step approval wait for a person (WRITE_APPROVAL_TTL_DAYS). Its own file, so approvals.ts keeps naming
// only the change approvals' constant (a pinned test reads its source), and the write TTL can move alone.
import { WRITE_APPROVAL_TTL_DAYS } from "@agentx/cloud-contracts";

export const WRITE_APPROVAL_TTL_MS = WRITE_APPROVAL_TTL_DAYS * 86_400_000;
