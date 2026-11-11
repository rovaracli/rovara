import "./insights.css";
import { useState } from "react";
import { ApiError } from "../../api/errors.js";
import { useInsightsOverview } from "../../api/insights.js";
import { useNav } from "../../api/nav.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Select } from "../../design/Select.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { FlowPanel } from "./FlowPanel.js";
import { InsightsViewerAccess } from "./InsightsViewerAccess.js";
import { ShippedPanel } from "./ShippedPanel.js";
import { SpendPanel } from "./SpendPanel.js";
import { StuckPanel } from "./StuckPanel.js";

const ALL = "__all";
const status = (error: unknown): number | undefined => error instanceof ApiError ? error.status : undefined;
const TITLE = "Insights";
const DESCRIPTION = "Where work is stuck, what shipped, what it cost and how work flows. For people who manage work, not do it.";
function Notice({ children }: { children: string }) { return <section className="rv-ins-notice"><PageHeader title={TITLE} description={DESCRIPTION} /><p role="status">{children}</p></section>; }

export function InsightsScreen() {
 const nav = useNav(), person = nav.data?.me.developerId, overview = useInsightsOverview(person);
 const [project, setProject] = useState(ALL);
 if (overview.isPending) return <section><PageHeader title={TITLE} description={DESCRIPTION} /><Skeleton label="Loading Insights" /></section>;
 if (overview.isError) {
  const code = status(overview.error);
  if (code === 403) return <Notice>Insights isn&apos;t open to you. Owners, admins, Insights viewers and project maintainers can see it. Ask a company owner or admin if you need access.</Notice>;
  if (code === 404) return <Notice>Insights isn&apos;t turned on for your company yet.</Notice>;
  return <section><PageHeader title={TITLE} description={DESCRIPTION} /><p role="alert">Couldn&apos;t load Insights. No figures are shown. <button type="button" className="rv-ins-link-button" onClick={() => { void overview.refetch(); }}>Try again</button></p></section>;
 }
 const data = overview.data;
 if (!data.enabled) return <Notice>Insights isn&apos;t turned on for your company yet.</Notice>;
 const scope = data.viewer.scope, projects = scope.kind === "projects" ? scope.projects ?? [] : [];
 if (scope.kind === "unknown") return <Notice>Insights couldn&apos;t tell which work you can see, so nothing is shown.</Notice>;
 const selected = project !== ALL && projects.includes(project) ? project : undefined;
 const canGrant = data.viewer.role === "owner" || data.viewer.role === "admin";
 return <section className="rv-insights" aria-busy={overview.isFetching}>
  <PageHeader title={TITLE} description={DESCRIPTION} />
  <p className="rv-ins-scope" role="note">{scope.kind === "company" ? "Showing the whole company." : projects.length === 0 ? "You don't maintain any projects yet, so there is nothing to show." : selected !== undefined ? "Showing one of the projects you maintain." : `Showing the projects you maintain: ${projects.join(", ")}.`}{data.viewer.contentLevel === "metadata_only_elsewhere" && " You can see that work exists and its state; you only see what a task says where you could already open it."}</p>
  {data.capture.workEvents === "off" && <p className="rv-muted" role="note">Rovara is not recording work history yet, so Shipped outcomes and Flow health fill in later.</p>}
  {scope.kind === "projects" && projects.length > 1 && <Select label="Project" value={selected ?? ALL} onValueChange={setProject} options={[{ value: ALL, label: "All my projects" }, ...projects.map(name => ({ value: name, label: name }))]} />}
  {scope.kind === "projects" && projects.length === 0 ? null : <>
   <StuckPanel overview={data} person={person} project={selected} />
   <ShippedPanel overview={data} person={person} project={selected} />
   <SpendPanel overview={data} person={person} project={selected} />
   <FlowPanel overview={data} person={person} project={selected} />
  </>}
  {canGrant && person !== undefined && <InsightsViewerAccess orgScope={person} />}
  <p className="rv-muted rv-ins-asof">Up to date as of <VisibleText text={new Date(Date.parse(data.asOf)).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC"} />.</p>
 </section>;
}
