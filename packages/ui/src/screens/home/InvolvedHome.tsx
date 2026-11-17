import { Link } from "react-router";
import { involvedRows, useInvolvedTasks } from "../../api/work.js";
import { ToneDot } from "../../design/StatusDot.js";
import { VisibleText } from "../../design/VisibleText.js";
import { paths } from "../../paths.js";
import "../work/work.css";
import "./home.css";

/** How many involved tasks Home lists; the Work page lists them all. */
const HOME_INVOLVED_MAX = 5;

/**
 * The tasks the person was added to (web task channel K4), under Home's own cards: a short list that opens each one in Work. It draws nothing while loading, when there are none, and when Code
 * does not serve the list yet or fails: Home never says "involved" to a person who is not, and an unserved list is not an error here (Work says so quietly if it could not load).
 */
export function InvolvedHome() {
 const involved = useInvolvedTasks();
 if (involved.data === undefined) return null;
 const rows = involvedRows(involved.data, new Date());
 if (rows.length === 0) return null;
 return <section className="rv-home-involved" aria-labelledby="home-involved-heading" data-testid="home-involved">
  <h2 id="home-involved-heading" className="rv-inbox-group">Involved <span>{rows.length}</span></h2>
  <ul className="rv-inbox-list" aria-label="Tasks you're involved in">
   {rows.slice(0, HOME_INVOLVED_MAX).map(row => <li key={row.id}>
    <Link className="rv-inbox-row" to={`${paths.live}?task=${encodeURIComponent(row.id)}`} data-task-id={row.id}>
     <ToneDot tone={row.tone} words={row.line} />
     <span className="rv-inbox-main"><b><VisibleText text={row.title} /></b><small><VisibleText text={row.line} /> · <VisibleText text={row.project} /></small></span>
     <span className="rv-inbox-meta"><span className="mono">{row.age}</span></span>
    </Link>
   </li>)}
  </ul>
  {rows.length > HOME_INVOLVED_MAX && <p className="rv-muted"><Link to={paths.live}>See all {rows.length} in Work</Link></p>}
 </section>;
}
