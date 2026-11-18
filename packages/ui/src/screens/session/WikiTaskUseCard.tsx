import { Link } from "react-router";
import { useLoadedLessons } from "../../api/lessons.js";
import { useWikiIndex } from "../../api/wiki.js";
import { VisibleText } from "../../design/VisibleText.js";

/** A compact task page record of the wiki pages the agent received and opened. */
export function WikiTaskUseCard({ project, taskId }: { project: string; taskId: string }) {
 const read = useLoadedLessons(project, taskId, true), wiki = useWikiIndex(project, read.data?.wikiUse !== undefined);
 const use = read.data?.wikiUse;
 if (use === undefined || use.read.length === 0) return null;
 const names = new Map((wiki.data?.pages ?? []).map(page => [page.pageId, page.title]));
 return <section className="rv-card" aria-label="Wiki pages this task read" data-testid="wiki-task-use">
  <h4>Wiki pages this task read</h4>
  <ul>{use.read.slice(0, 3).map(id => <li key={id}><Link to={`/app/projects/${encodeURIComponent(project)}?tab=wiki&page=${encodeURIComponent(id)}`}><VisibleText text={names.get(id) ?? id} /></Link></li>)}</ul>
  {use.read.length > 3 && <details><summary>Show all {use.read.length} pages</summary><ul>{use.read.slice(3).map(id => <li key={id}><Link to={`/app/projects/${encodeURIComponent(project)}?tab=wiki&page=${encodeURIComponent(id)}`}><VisibleText text={names.get(id) ?? id} /></Link></li>)}</ul></details>}
 </section>;
}
