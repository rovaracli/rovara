import { Link, useSearchParams } from "react-router";
import { useAreaRead, useReadContext } from "./ReadEntry.js";
import { ReadState } from "./ReadState.js";
import { Block, Chip, Held, readAt, whenAt, whenShort } from "./parts.js";
import { VisibleText } from "../../design/VisibleText.js";
const tick = <svg className="g4-tick" aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m4 8.5 2.5 2.5L12 5.5" /></svg>;
const note = (text: string | undefined) => text ?? "No publication note returned.";
/** The rail beside the rules: the newest served rule versions, with a way to the whole list. No comparison or roll back is shown. */
export function RuleHistoryRail({ agentId }: { agentId: string }) {
 const { api } = useReadContext(), read = useAreaRead(["history", agentId], () => api.history(agentId)), [params] = useSearchParams();
 const next = new URLSearchParams(params);next.set("tab", "how-we-work");next.set("view", "history");
 return <Block id="g4-history" title="What changed, and when" className="g4-rail"><ReadState read={read} refName="RULE-VERSIONS">{data => {
  const versions = [...data.versions].sort((a, b) => b.version - a.version);
  return versions.length === 0 ? <Held>No versions were returned.</Held> : <>
   <ol className="g4-timeline">{versions.slice(0, 4).map(version => <li key={version.version}>
    <span className="g4-node">{tick}</span>
    <div className="g4-timeline-head"><h3>Version {version.version}{version.current === true && <span className="g4-live"> · live</span>}</h3>{version.publishedAt !== undefined && <time className="g4-mono" dateTime={version.publishedAt}>{whenShort(version.publishedAt)}</time>}</div>
    <p>{version.publishedBy !== undefined && <><VisibleText text={version.publishedBy} /> · </>}{note(version.note)}</p>
   </li>)}</ol>
   <Link className="rv-button rv-button-secondary g4-all" to={{ search: "?" + next.toString() }} replace>See all {versions.length} {versions.length === 1 ? "version" : "versions"}</Link>
   <p className="g4-quiet g4-foot">A task keeps the version it started with. Publishing a new version never changes a running task.</p></>;
 }}</ReadState></Block>;
}
/** History: every served version of the rules, newest first, one row each. */
export function RuleHistoryView({ agentId }: { agentId: string }) {
 const { api } = useReadContext(), read = useAreaRead(["history", agentId], () => api.history(agentId));
 return <ReadState read={read} scope="page" refName="PROJECT-HISTORY">{data => {
  const versions = [...data.versions].sort((a, b) => b.version - a.version);
  return <Block id="g4-history" title={`${versions.length} ${versions.length === 1 ? "version" : "versions"}`} aside={readAt(read.dataUpdatedAt)}>
   {versions.length === 0 ? <Held>No versions were returned.</Held> : <ol className="g4-versions" aria-label="Rule versions">{versions.map(version => <li key={version.version}>
    <span className="g4-version-no">v{version.version}</span>
    <div><h3>{note(version.note)}</h3><p className="g4-quiet">{version.publishedBy !== undefined && <><VisibleText text={version.publishedBy} /></>}{version.publishedAt !== undefined && <>{version.publishedBy !== undefined && " · "}<time dateTime={version.publishedAt}>{whenAt(version.publishedAt)}</time></>}</p></div>
    {version.current === true && <Chip tone="ok">Live</Chip>}
   </li>)}</ol>}
   <p className="g4-quiet g4-foot">A task keeps the version it started with. Publishing a new version never changes a running task.</p>
  </Block>;
 }}</ReadState>;
}
