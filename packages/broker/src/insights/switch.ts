// Insights (srv/insights-reads): the per-company-install switch. It is on only when the broker's INSIGHTS_ENABLED variable is exactly "1"; anything else (unset, empty, "true", " 1") is off, and with it off
// every Insights path except the overview answers as any unknown path (the overview answers `enabled: false`, so the navigation can hide the entry).
// PENDING WIRING (needs an infrastructure change, so it is not part of this lane): the packed broker setting (`BROKER_SETTINGS`, a stack parameter `InsightsEnabled`, "0" by default, its CLI key and
// `docs/day-two.md`), so that an operator can turn it on. Until then the variable can only be set in the Lambda's own environment and the switch stays off.
export const INSIGHTS_ENABLED_VARIABLE = "INSIGHTS_ENABLED";

export const insightsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env[INSIGHTS_ENABLED_VARIABLE] === "1";
