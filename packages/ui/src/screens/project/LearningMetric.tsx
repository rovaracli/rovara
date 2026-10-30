import { Link } from "react-router";
import type { ProjectOverviewLearning } from "@agentx/contracts/web";
import { useHowWeWork } from "../../api/how-we-work.js";
import { VisibleText } from "../../design/VisibleText.js";
import { METRIC_TEXT as T, afterRuleText, lastMonthText, percentOf, ruleRepeatsText, shareText, soFarText, stageLabel } from "./learning-text.js";
import "./learning.css";

/** "Same correction given twice": the share of this month's member corrections that repeated an earlier one (it should fall), and the repeats that came after an accepted rule. Counts and stage names only; no rule or correction words are sent. */
export function LearningMetric({ project, learning }: { project: string; learning: ProjectOverviewLearning }) {
 // The stage names come from How we work; until that read ends (or fails, which falls back to the ids) the list waits, so a stage is not shown as its id and then renamed.
 const how = useHowWeWork(project), names = new Map((how.data?.stages ?? []).map(stage => [stage.id, stage.name]));
 const { thisMonth, lastMonthShare, repeatsAfterRule, repeatsAfterRuleLabel } = learning, enough = thisMonth.enoughData, href = "/app/projects/" + encodeURIComponent(project) + "?tab=how-we-work";
 const total = repeatsAfterRule.reduce((sum, item) => sum + item.repeats, 0), capped = repeatsAfterRuleLabel !== undefined;
 return <section className="rv-project-section" aria-labelledby="learning-metric-title"><h2 id="learning-metric-title">{T.HEADING}</h2>
  {enough ? <p><strong>{shareText(thisMonth.repeats, thisMonth.corrections)}</strong>{lastMonthShare !== undefined && <> · <span className="rv-muted">{lastMonthText(percentOf(thisMonth.repeats, thisMonth.corrections), lastMonthShare)}</span></>}</p>
   : <p><strong>{T.NOT_ENOUGH}</strong> <span className="rv-muted">{soFarText(thisMonth.corrections)}</span></p>}
  {repeatsAfterRule.length > 0 && !how.isPending && <><p>{afterRuleText(total, repeatsAfterRuleLabel)}</p><ul className="rv-learning-sources" aria-label={T.AFTER_RULE_LIST}>{repeatsAfterRule.map(item => <li key={item.ruleId}><Link to={href}><VisibleText text={ruleRepeatsText(stageLabel(item.stage, names), item.repeats, capped)} /></Link></li>)}</ul></>}
  <p className="rv-muted">{T.HELP}</p>
 </section>;
}
