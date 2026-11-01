import { useLessonsDigest, type LessonsDigest } from "../../../api/lessons.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { safeExternalUrl } from "../../../text/links.js";
import { T, typeWords } from "./lessons-text.js";

type Items = LessonsDigest["top"];
function Group({ heading, items }: { heading: string; items: Items }) {
 if (items.length === 0) return null;
 return <section aria-label={heading}><h4>{heading}</h4><ul>{items.map(item => <li key={item.id}><VisibleText text={item.title} /> <span className="rv-muted">· {typeWords(item.type)}</span>{item.links.flatMap(link => { const url = safeExternalUrl(link);return url === undefined ? [] : [<span key={link}> · <a href={url} target="_blank" rel="noreferrer noopener">pull request</a></span>]; })}</li>)}</ul></section>;
}

/** The weekly digest, led by the top lessons (measured outcomes first, then recurrence, then severity). For people who decide. */
export function Digest({ project }: { project: string }) {
 const read = useLessonsDigest(project, true);
 if (read.isPending) return <p className="rv-muted" role="status">Loading the digest</p>;
 if (read.isError) return <p className="rv-muted" role="alert">The digest could not be loaded right now.</p>;
 const d = read.data, empty = [d.top, d.needsReview, d.autoApplied, d.waiting, d.retired, d.staleOrRetireProposed].every(items => items.length === 0) && d.pausedSources.length === 0 && d.pausedSourcesHidden === 0;
 return <div className="rv-lessons-digest">
  {empty && <p className="rv-muted">{T.DIGEST_NONE}</p>}
  <Group heading={T.DIGEST_TOP} items={d.top} />
  <Group heading={T.DIGEST_WAITING} items={d.waiting} />
  <Group heading={T.DIGEST_REVIEW} items={d.needsReview} />
  <Group heading={T.DIGEST_AUTO} items={d.autoApplied} />
  <Group heading={T.DIGEST_RETIRED} items={d.retired} />
  <Group heading={T.DIGEST_STALE} items={d.staleOrRetireProposed} />
  {d.pausedSources.length > 0 && <section aria-label={T.DIGEST_PAUSED}><h4>{T.DIGEST_PAUSED}</h4><ul>{d.pausedSources.map(source => <li key={source}><VisibleText text={source} /></li>)}</ul></section>}
  {d.pausedSourcesHidden > 0 && <p className="rv-muted">{String(d.pausedSourcesHidden)} {T.DIGEST_PAUSED_HIDDEN}</p>}
  {d.queued > 0 && <p className="rv-muted">{String(d.queued)} {T.QUEUED}</p>}
 </div>;
}
