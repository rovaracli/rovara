import type { ReadAgentProfile } from "../../api/agents.js";
import type { ReadAgentSummary } from "../../api/agent-publish.js";
import { Money } from "../../design/Money.js";
import { VisibleText } from "../../design/VisibleText.js";
import { summaryLines } from "./publish-words.js";

/**
 * What an agent can do, as the approver is told it (the doc's AgentSummary): steps, tools and access, autonomy, how it starts, skills, budgets, and the sentences that say what would make it less safe.
 * `fromProfile` builds the same facts from the published recipe the person is looking at, for the ask screen, where no request exists yet; the server's own summary replaces it once one does.
 */
export function summaryFromProfile(profile: ReadAgentProfile): ReadAgentSummary | undefined {
 const recipe = profile.current?.recipe;
 if (recipe === undefined) return undefined;
 const kind = (trigger: { kind: string }): "manual" | "schedule" | "event" | undefined => trigger.kind === "person" ? "manual" : trigger.kind === "schedule" ? "schedule" : trigger.kind === "event" ? "event" : undefined;
 const base = recipe.chain.length > 1 ? recipe.chain[recipe.chain.length - 2] : undefined;
 return {
  steps: recipe.steps.length,
  tools: recipe.tools.map(tool => ({ connector: "type" in tool.connector ? String(tool.connector.type) : String(tool.connector.name), access: tool.access === "read" ? "read" as const : "read_write" as const })),
  autonomy: recipe.autonomy === "suggest" || recipe.autonomy === "prepare" || recipe.autonomy === "run" ? recipe.autonomy : "suggest",
  triggers: [...new Set(recipe.triggers.flatMap(trigger => { const mapped = kind(trigger);return mapped === undefined ? [] : [mapped]; }))],
  skills: recipe.skills.length,
  ...(profile.agent.monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd: profile.agent.monthlyBudgetUsd }),
  ...(profile.agent.maxPerRunUsd === undefined ? {} : { maxPerRunUsd: profile.agent.maxPerRunUsd }),
  ...(base === undefined || typeof base.version !== "number" ? {} : { extends: { agentId: base.agentId, version: base.version } }),
  lessSafe: [],
 };
}

export function PublishSummary({ summary, label = "What this agent can do" }: { summary: ReadAgentSummary; label?: string }) {
 return <div className="rv-pub-summary" role="group" aria-label={label}>
  <dl className="rv-pub-facts">
   {summaryLines(summary).map(line => <div key={line.label}><dt>{line.label}</dt><dd><VisibleText text={line.value} /></dd></div>)}
   <div><dt>Monthly budget</dt><dd>{summary.monthlyBudgetUsd === undefined ? "No limit" : <Money usd={summary.monthlyBudgetUsd} />}</dd></div>
   <div><dt>Most per run</dt><dd>{summary.maxPerRunUsd === undefined ? "No limit" : <Money usd={summary.maxPerRunUsd} />}</dd></div>
  </dl>
  {summary.lessSafe.length > 0 && <div className="rv-pub-less-safe"><p><strong>This makes the agent less safe:</strong></p><ul>{summary.lessSafe.map((sentence, index) => <li key={index}><VisibleText text={sentence} /></li>)}</ul></div>}
 </div>;
}
