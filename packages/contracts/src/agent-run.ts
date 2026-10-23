


export const AGENT_RUN_STATES = ["RUNNING", "WAITING_FOR_APPROVAL", "PAUSED_BUDGET", "COMPLETE", "FAILED", "CANCELLED"] as const;

export const AGENT_RUN_STEP_STATUSES = ["pending", "running", "waiting", "done", "failed"] as const;
