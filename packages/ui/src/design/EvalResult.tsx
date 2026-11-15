import { VisibleText } from "./VisibleText.js";

export interface EvalResultProps {
 /** Cases that passed, of how many, and the bar to reach (a fraction, 0 to 1, as Code's proof index sends it). */
 passed: number; total: number; bar?: number | undefined;
 /** The score before this change, the judge model and the breakdown by slice: shown only when Code sends them. */
 baseline?: number | undefined; judge?: string | undefined; slices?: ReadonlyArray<{ name: string; passed: number; total: number }> | undefined;
 /** A failed eval draws its bar in the failed colour. */
 failed?: boolean | undefined;
}
const percent = (fraction: number): string => (Math.round(fraction * 1000) / 10).toFixed(1);

/** An eval as one proof row's box: cases passed, the bar, the score before when known, and a bar graphic that marks where the bar is. */
export function EvalResult({ passed, total, bar, baseline, judge, slices, failed = false }: EvalResultProps) {
 if (!(total > 0) || passed < 0 || passed > total) return <div className="rv-eval"><p>Eval result unavailable.</p></div>;
 const score = passed / total, low = Math.min(score, bar ?? score, 1) - 0.1, scale = (value: number) => Math.max(0, Math.min(100, ((value - low) / (1 - low)) * 100));
 return <div className="rv-eval" data-failed={failed || undefined}>
  <div className="rv-eval-head"><b>{passed} of {total} cases pass · {percent(score)}%</b>
   <span className="rv-muted">{[bar === undefined ? undefined : `bar ${percent(bar)}%`, baseline === undefined ? undefined : `before this change ${percent(baseline)}%`, judge === undefined ? undefined : "judged by " + judge].filter(Boolean).join(" · ")}</span></div>
  <div className="rv-eval-bar" role="img" aria-label={`${percent(score)} percent${bar === undefined ? "" : ", the bar is " + percent(bar) + " percent"}${failed ? ", below the bar" : ""}`}><i className={failed ? "bad" : ""} style={{ width: scale(score) + "%" }} />{bar !== undefined && <u style={{ left: scale(bar) + "%" }} />}</div>
  {slices !== undefined && slices.length > 0 && <ul className="rv-eval-slices">{slices.map(slice => <li key={slice.name}><VisibleText text={slice.name} /> <b>{slice.passed}/{slice.total}</b></li>)}</ul>}
 </div>;
}
