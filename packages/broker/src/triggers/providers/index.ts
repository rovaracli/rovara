// The providers of event sources (Plan 4 Tasks 22 to 25): one per source, each saying how its deliveries are verified and read. A source with no provider can't have a hook created
// for it, and a delivery to one is refused. Each task adds its providers to this table.
import type { HookSource } from "@rovara-code/contracts";
import { cloudwatchProvider } from "./cloudwatch-sns.js";
import { datadogProvider } from "./datadog.js";
import { grafanaProvider } from "./grafana.js";
import { jiraProvider } from "./jira.js";
import { linearProvider } from "./linear.js";
import { pagerdutyProvider } from "./pagerduty.js";
import { sentryProvider } from "./sentry.js";
import { vercelProvider } from "./vercel.js";
import type { HookProvider } from "./types.js";

export function hookProviders(): Partial<Record<HookSource, HookProvider>> {
  return { linear: linearProvider, jira: jiraProvider, pagerduty: pagerdutyProvider, sentry: sentryProvider, datadog: datadogProvider, grafana: grafanaProvider, vercel: vercelProvider, cloudwatch: cloudwatchProvider };
}
