import { lazy, Suspense } from "react";
import { useLessonSources } from "../../../api/lessons.js";
import { useProject } from "../../../api/projects.js";
import { useSourcesAdmin } from "../../../api/record-sources.js";
import { ApiError } from "../../../api/errors.js";
import { Banner } from "../../../design/Banner.js";
import { Button } from "../../../design/Button.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { T, healthWords, kindWords, retentionWords } from "./lessons-text.js";
import "./lessons.css";

// The editing screen is its own chunk: it loads only when the record route returned the editors' view (a maintainer of this project, or an owner or admin, in a live browser session).
const SourcesAdmin = lazy(() => import("./SourcesAdmin.js"));

/** "Sources": what feeds the team record for this project, how long Rovara keeps it, and how each source is doing. Members read it here; a person who may edit gets the editing screen. A source kept for maintainers is named only to a maintainer. */
export function SourcesTab({ project }: { project: string }) {
 const read = useLessonSources(project), person = useProject(project);
 // Only a maintainer of the project is asked for the editors' view; the server still decides (a reply that is not the editors' view leaves this tab read-only).
 const maintainer = person.data?.you.role === "maintainer", admin = useSourcesAdmin(project, maintainer);
 if (maintainer && admin.isPending) return <section className="rv-lessons" aria-label={T.SOURCES_TITLE}><Skeleton label={T.SOURCES_LOADING} /></section>;
 if (admin.data?.canEdit === true) return <Suspense fallback={<section className="rv-lessons" aria-label={T.SOURCES_TITLE}><Skeleton label={T.SOURCES_LOADING} /></section>}><SourcesAdmin project={project} view={admin.data} /></Suspense>;
 if (read.isPending) return <section className="rv-lessons" aria-label={T.SOURCES_TITLE}><Skeleton label={T.SOURCES_LOADING} /></section>;
 if (read.isError || read.data === undefined) {
  const gone = read.error instanceof ApiError && read.error.code === "NOT_FOUND";
  return <section className="rv-lessons" aria-label={T.SOURCES_TITLE}><p role="alert">{gone ? T.SOURCES_UNAVAILABLE : "Couldn't load the sources. Try again."}</p>{!gone && <Button onClick={() => { void read.refetch(); }}>{T.TRY_AGAIN}</Button>}</section>;
 }
 const data = read.data;
 return <section className="rv-lessons" aria-label={T.SOURCES_TITLE}>
  <Banner title={T.SOURCES_BANNER} tone="info" />
  {admin.isError && !(admin.error instanceof ApiError && admin.error.code === "NOT_FOUND") && <p className="rv-muted">{T.SRC_NO_EDIT}</p>}
  {data.sources.length === 0 ? <p className="rv-muted">{T.SOURCES_NONE}</p> : <ul className="rv-lessons-list" aria-label={T.SOURCES_TITLE}>{data.sources.map((source, index) => <li key={index} className="rv-lessons-source">
   <h3>{kindWords(source.kind)}{source.scope !== undefined ? <> <span className="rv-muted"><VisibleText text={source.scope} /></span></> : <span className="rv-muted"> · {T.SOURCE_HIDDEN}</span>}</h3>
   <p>{T.KEEPS}: <strong>{retentionWords(source.retention)}</strong>{source.notesOptIn === true && <span className="rv-muted"> (notes with links, switched on by your admin)</span>}</p>
   <p>{T.STATUS}: {source.enabled ? T.SOURCE_ON : T.SOURCE_OFF} · {healthWords(source.health)}{source.excluded !== undefined && source.excluded > 0 && <span className="rv-muted"> · {String(source.excluded)} {T.SOURCE_EXCLUDED}</span>}</p>
   <p className="rv-muted">{T.WHO_SEES}: {source.audience === "project" ? "Everyone on this project" : "Maintainers only"}</p>
   {source.paused && <Banner title={T.SOURCE_PAUSED} tone="warning" />}
  </li>)}</ul>}
  {data.otherPaused > 0 && <p className="rv-muted">{String(data.otherPaused)} {T.SOURCE_PAUSED_OTHER}</p>}
 </section>;
}
