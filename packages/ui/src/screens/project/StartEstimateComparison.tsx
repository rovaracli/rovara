import { formatUsdMicrodollars, type PathQuote, type PreviewV2, type QuoteField, type QuoteRange } from "@agentx/contracts/web";
const amount = (f: QuoteField<number>) => f.state === "available" ? formatUsdMicrodollars(f.value) : "unavailable";
const range = (f: QuoteField<QuoteRange>) => f.state === "available" ? `about ${formatUsdMicrodollars(f.value.lowMicros)} to ${formatUsdMicrodollars(f.value.highMicros)}` : "whole-task estimate unavailable";
const name = (path: PathQuote["path"]) => path === "QUICK" ? "Quick" : "Full";
const scopes: Record<string, string> = { engine_task: "Task limit on this install", project_task: "Project task limit", engine_day: "Daily limit on this install", gateway_task: "AI task limit", project_month: "Project monthly limit", person_month: "Your monthly limit", company_month: "Company monthly limit", purpose_month: "Monthly limit for this kind of work" };
const stages: Record<string, string> = { legacy_aggregate: "Base work", designReview: "Design review", secondReview: "Second review", eval: "Evaluation", plan: "Planning", build: "Building", review: "Review", test: "Testing" };
export const quoteCostSummary = (quote: PreviewV2): string => quote.options.map(q => `${name(q.path)}: ${range(q.range)}`).join("; ");
/** Advisory estimates; all supporting figures stay together in the explanation. */
export function StartEstimateComparison({ quote }: { quote: PreviewV2 }) {
 return <section aria-label="Quick and Full cost estimates" className="rv-muted">
  {quote.options.map(q => <p key={q.path}>{name(q.path)}: {range(q.range)}.</p>)}
  <p>An estimate, not a charge.</p>
  <details><summary>How this is worked out</summary>
   <p>No money is reserved. Spending is checked when work starts. Estimates may change; Quick may need Full. Computer costs are excluded.</p>
   {quote.options.map(q => <div key={q.path}>
    <p>{name(q.path)}: {q.basis.kind === "default" ? "Default estimate" : "Based on past tasks"}; {q.basis.samples} past tasks; {q.basis.modelPriced ? "uses model prices" : "not model-priced"}.</p>
    <p>Planning allowance: {amount(q.planningAllowanceMicros)}. Initial hold if started: {amount(q.initialHoldMicros)}.</p>
    <p>{q.limitCoverage === "partial" ? "Some limits can only be checked when the task runs. " : "Known limits have been checked. "}{q.firstBindingLimit.state === "available" && q.firstBindingLimit.value !== null ? `${scopes[q.firstBindingLimit.value.scope] ?? "Spending limit"}: ${formatUsdMicrodollars(q.firstBindingLimit.value.availableMicros)} available; ${q.firstBindingLimit.value.appliesAt === "start" ? "checked when work starts" : q.firstBindingLimit.value.appliesAt === "task_total" ? "applies to the whole task" : "checked when the task runs"}${q.firstBindingLimit.value.blocked === true ? "; blocked" : q.firstBindingLimit.value.blocked === null ? "; amount needed is not known yet" : ""}.` : "The first limit that may stop work is unavailable."}</p>
    <ul aria-label={`${name(q.path)} stages`}>{q.stages.map(s => <li key={s.stage}>{stages[s.stage] ?? "Work stage"}: {s.optional ? (s.included ? "optional, included" : "optional, excluded") : "included"}; {range(s.range)}. Model: {s.model.state === "available" ? s.model.value.modelId : "unavailable"}. Source: {s.source.state === "available" ? s.source.value.name : "unavailable"}. Price basis: {s.price.state === "available" ? s.price.value.version : "unavailable"}.</li>)}</ul>
   </div>)}
  </details>
 </section>;
}
