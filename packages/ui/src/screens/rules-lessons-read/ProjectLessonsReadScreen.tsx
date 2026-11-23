import { servedReadState } from "../../api/served-read.js";
import { useAreaRead, useReadContext } from "./ReadEntry.js";
import { ReadState } from "./ReadState.js";
import { Block, Held, readAt } from "./parts.js";
import { LearnedSection } from "../project/LearnedSection.js";
const tick = <svg className="g4-icon g4-icon-ok" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-6.5" /></svg>;
/** "2026-11" as the viewer's own "November 2026"; anything else stays as served. */
function monthName(month: string): string { const match = /^(\d{4})-(\d{2})$/.exec(month);return match === null ? month : new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" }); }
const alert = <svg className="g4-icon g4-icon-attention" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 4.8v3.8M8 11v.2" /></svg>;
/** Learned: this week's served summary on top, then the live lesson tools (lists, retiring, mode, sources, checks) as one block. */
export function LearnedView({ project }: { project: string }) {
 const { api } = useReadContext();
 const weekly = useAreaRead([project, "weekly"], () => api.weekly(project)), repeats = useAreaRead([project, "repeats"], () => api.repeats(project));
 const fresh = new Set((servedReadState(weekly).data?.weekly.picks ?? []).map(pick => String(pick["lessonId"])));
 return <div className="g4-learned">
  <Block id="g4-week" title="This week" aside={readAt(weekly.dataUpdatedAt)}>
   <ReadState read={weekly} refName="LESSONS-WEEK">{data => data.weekly.needLook.length === 0 && data.weekly.picks.length === 0 ? <Held>No weekly items were returned.</Held> : <ul className="g4-weekly" aria-label="This week">{([[data.weekly.picks, false], [data.weekly.needLook, true]] as const).filter(([rows]) => rows.length > 0).map(([rows, look]) => <li key={String(look)}>{look ? alert : tick}<div><p className="g4-title">{look ? `${rows.length} ${rows.length === 1 ? "lesson needs" : "lessons need"} a look` : `${rows.length} new ${rows.length === 1 ? "lesson" : "lessons"} picked`}</p><p className="g4-quiet">{rows.map(row => typeof row["title"] === "string" ? row["title"] : "We can’t tell yet what this item is.").map(text => "\u201C" + text + "\u201D").join(" · ")}</p></div></li>)}</ul>}</ReadState>
   <ReadState read={repeats} refName="LESSONS-REPEATS">{data => <p className="g4-quiet g4-foot">{data.enoughData ? `${data.repeated} of ${data.corrections} corrections were repeats in ${monthName(data.month)}.` : `Not enough evidence yet (${data.corrections} corrections).`}{data.truncated === true && " Only part of the evidence was counted."} A lesson being loaded does not mean a task used it.</p>}</ReadState>
  </Block>
  <LearnedSection project={project} embedded fresh={fresh} />
 </div>;
}
