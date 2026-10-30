// v1.2 learning loop, B7: the maintainer-only `learning` block of a project's overview (design 6.2 and 6.4). It is built from the METRIC items of this month and last, the project's active rules, and
// the repeats of those rules among this month's corrections. Counts and ids only. A project created again under the same name has none of the old counts (reads ignore another project's items).
import { LearningRuleSchema, type ProjectOverviewLearning } from "@agentx/contracts";
import { prCaptureOff } from "./grouping.js";
import { metricMonth, readMetric } from "./metric.js";
import { readLearningPartition, type LearningDeps, type LearningScope } from "./store.js";

/** The most of this month's corrections read to count the repeats after rules. */
export const OVERVIEW_CORRECTIONS_MAX = 500;
const RULES_MAX = 100;
const RULES_LISTED_MAX = 50;

function previousMonth(month: string): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, number - 2, 1)).toISOString().slice(0, 7);
}

export async function learningOverviewBlock(deps: LearningDeps, scope: LearningScope): Promise<ProjectOverviewLearning> {
  const month = metricMonth(new Date(deps.now()).toISOString());
  const off = await prCaptureOff(deps, scope);
  const [thisMonth, lastMonth] = await Promise.all([
    readMetric(deps, scope, month, { prCaptureOff: off }),
    readMetric(deps, scope, previousMonth(month), { prCaptureOff: off }),
  ]);

  const rules = new Map<string, { ruleId: string; stage: string }>();
  for (const item of (await readLearningPartition(deps, scope, { prefix: "RULE#", maxItems: RULES_MAX, maxPages: 1, pageSize: RULES_MAX })).items) {
    const parsed = LearningRuleSchema.safeParse(item);
    if (parsed.success && parsed.data.status === "active") rules.set(parsed.data.id, { ruleId: parsed.data.id, stage: parsed.data.stage });
  }
  const repeats = new Map<string, number>();
  if (rules.size > 0) {
    const page = await readLearningPartition(deps, scope, { prefix: `CORRECTION#${month}`, maxItems: OVERVIEW_CORRECTIONS_MAX, maxPages: 1, pageSize: OVERVIEW_CORRECTIONS_MAX });
    for (const item of page.items) {
      const rule = typeof item["repeatOf"] === "string" ? item["repeatOf"] : undefined;
      if (rule === undefined || !rules.has(rule) || item["standing"] !== "member" || (off && item["source"] === "pr_comment")) continue;
      repeats.set(rule, (repeats.get(rule) ?? 0) + 1);
    }
  }
  return {
    thisMonth: { repeats: thisMonth.repeats, corrections: thisMonth.memberCorrections, enoughData: thisMonth.enoughData },
    ...(lastMonth.share === null ? {} : { lastMonthShare: lastMonth.share }),
    repeatsAfterRule: [...repeats].map(([ruleId, count]) => ({ ...rules.get(ruleId)!, repeats: count })).sort((a, b) => b.repeats - a.repeats || (a.ruleId < b.ruleId ? -1 : 1)).slice(0, RULES_LISTED_MAX),
  };
}
