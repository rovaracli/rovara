import type { ReadPlan, WorkRow } from "../../api/work.js";
import { VisibleText } from "../../design/VisibleText.js";

const DATE = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const when = (iso: string): string => (Number.isNaN(Date.parse(iso)) ? iso : DATE.format(new Date(iso)) + " UTC");

/**
 * The first step: what was asked. The request is the task's title with where and how it runs (Code sends the title, not the full text of the request), and
 * the questions Rovara asked before it wrote the spec, with the answer it will use if nobody answers. Questions are answered in the spec, beside the
 * criterion each one settles, or on the decision card.
 */
export function RequestStep({ row, plan }: { row: WorkRow; plan: ReadPlan | undefined }) {
 const questions = plan?.questions ?? [];
 return <section aria-label="Request" className="rv-request">
  <div className="rv-section-head"><h3>Request</h3><span>Started {when(row.task.createdAt)}</span></div>
  <p className="rv-request-title"><VisibleText text={row.title} /></p>
  <dl className="rv-kv-list">
   <div className="rv-kv"><dt>Project</dt><dd><VisibleText text={row.project} /></dd></div>
   {row.path !== undefined && <div className="rv-kv"><dt>Way</dt><dd>{row.path}</dd></div>}
   <div className="rv-kv"><dt>Now</dt><dd><VisibleText text={row.line} /></dd></div>
  </dl>
  {questions.length > 0 && <div className="rv-request-questions"><h4>Questions Rovara asked</h4><ul>{questions.map(question => {
   const fallback = question.options.find(option => option.optionId === question.defaultOptionId)?.label;
   return <li key={question.questionId}><VisibleText text={question.text} />{question.criterionId !== undefined && <span className="rv-id-chip"> {question.criterionId}</span>}{fallback !== undefined && <span className="rv-muted"> If nobody answers, Rovara uses "<VisibleText text={fallback} />".</span>}</li>;
  })}</ul></div>}
 </section>;
}
