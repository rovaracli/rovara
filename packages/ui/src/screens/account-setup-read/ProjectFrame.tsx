import type { ReactNode } from "react";
import { PageHeader } from "../../design/PageHeader.js";
import type { StatusChipProps } from "../../design/StatusChip.js";
import { ReconnectingLine } from "./reconnecting.js";

const TABS = ["Tasks", "How we work", "Sources", "People", "Setup", "Settings"] as const;
/**
 * The project page's own header and section tabs, as the boards frame the Setup pages. The project page owns the real ones;
 * this frame is used where a Setup page stands alone (and in capture). Only the project name is known here, so the state chip is
 * the Unknown chip unless the caller read a state, and the tabs are labels, not links.
 */
export function ProjectFrame({ project, status = { state: "unknown" }, meta, children }: { project: string; status?: StatusChipProps; meta?: ReactNode; children?: ReactNode }) {
 return <div className="g5-frame g5-account-setup-read">
  <PageHeader title={project} breadcrumbs={[{ label: "Projects", href: "/app/admin/projects" }]} status={status} {...(meta === undefined ? {} : { meta })} />
  <nav aria-label="Project sections"><ul className="g5-tabs">{TABS.map(tab => <li key={tab} {...(tab === "Setup" ? { "aria-current": "page" as const } : {})}>{tab}</li>)}</ul></nav>
  <ReconnectingLine />
  {children}
 </div>;
}
