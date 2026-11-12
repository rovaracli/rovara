// Insights (srv/insights-reads): the per-company-install switch. It is on only when the broker's INSIGHTS_ENABLED variable is exactly "1"; anything else (unset, empty, "true", " 1") is off, and with it off
// every Insights path except the overview answers as any unknown path (the overview answers `enabled: false`, so the navigation can hide the entry).
// It is a packed broker setting (`BROKER_SETTINGS.insights`, code `in`; stack parameter InsightsEnabled, "0" by default; CLI key `insights.enabled`; `docs/day-two.md`), unpacked into this variable at start-up.
export const INSIGHTS_ENABLED_VARIABLE = "INSIGHTS_ENABLED";

export const insightsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env[INSIGHTS_ENABLED_VARIABLE] === "1";
