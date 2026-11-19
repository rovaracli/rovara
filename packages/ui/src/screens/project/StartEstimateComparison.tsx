import { formatUsdMicrodollars, type PathQuote, type PreviewV2, type QuoteField, type QuoteRange } from "@agentx/contracts/web";
const amount = (f: QuoteField<number>) => f.state === "available" ? formatUsdMicrodollars(f.value) : "unavailable";
const range = (f: QuoteField<QuoteRange>) => f.state === "available" ? `${formatUsdMicrodollars(f.value.lowMicros)}–${formatUsdMicrodollars(f.value.highMicros)}` : "whole-task estimate unavailable";
const name = (path: PathQuote["path"]) => path === "QUICK" ? "Quick" : "Full";
export const quoteCostSummary = (quote: PreviewV2): string => quote.options.map(q => `${name(q.path)}: ${range(q.range)}`).join("; ");
/** Advisory amounts and missing coverage stay distinct from the controls that admit the real start. */
export function StartEstimateComparison({ quote }: { quote: PreviewV2 }) {
 return <section aria-label="Quick and Full cost estimates" className="rv-muted">
  <p>No money is reserved and this quote does not authorize spending. Estimates may change; Quick may escalate to Full. Compute is excluded.</p>
  {quote.options.map(q => <div key={q.path}>
   <p>{name(q.path)}: {range(q.range)}. {q.basis.kind === "default" ? "Default estimate" : "History estimate"}, {q.basis.samples} samples; {q.basis.modelPriced ? "model-priced estimate" : "not model-priced"}.</p>
   <p>Planning allowance (a ceiling): {amount(q.planningAllowanceMicros)}. Initial hold if started: {amount(q.initialHoldMicros)}.</p>
   <p>Limit coverage: {q.limitCoverage}. {q.firstBindingLimit.state === "available" && q.firstBindingLimit.value !== null ? `First known limit: ${q.firstBindingLimit.value.scope.replaceAll("_", " ")}; ${formatUsdMicrodollars(q.firstBindingLimit.value.availableMicros)} available; checked at ${q.firstBindingLimit.value.appliesAt.replaceAll("_", " ")}${q.firstBindingLimit.value.blocked === true ? "; blocked" : q.firstBindingLimit.value.blocked === null ? "; next call requirement unavailable" : ""}.` : "First blocking limit unavailable."}</p>
   <details><summary>Stages and price basis for {name(q.path)}</summary><ul>{q.stages.map(s => <li key={s.stage}>{({ legacy_aggregate: "Base work (historical aggregate)", designReview: "Design review", secondReview: "Second review", eval: "Evaluation" } as Record<string, string>)[s.stage] ?? s.stage}: {s.optional ? (s.included ? "optional, included" : "optional, excluded") : "included"}; {range(s.range)}. Model: {s.model.state === "available" ? s.model.value.modelId : "unavailable"}. Source: {s.source.state === "available" ? s.source.value.name : "unavailable"}. Price basis: {s.price.state === "available" ? s.price.value.version : "unavailable"}.</li>)}</ul></details>
  </div>)}
 </section>;
}
