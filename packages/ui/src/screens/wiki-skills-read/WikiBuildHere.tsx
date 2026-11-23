import { servedReadState } from "../../api/served-read.js";
import { WikiChecklistRow } from "../setup/wiki/WikiChecklistRow.js";
import { useIdentity, useScope } from "./read-model.js";
import "../setup/checklist.css";

/**
 * "Build the wiki" on the empty Wiki tab: the SAME row the project checklist draws (its forecast, its Build button and its calls), so the tab is not a dead end. A person who may not build sees the row read-only; one who
 * may sees Build disabled, with the reason, while there is no AI key, no file to write about or no current read. The row owns every rule (Code decides who may; a failed re-read takes Build away).
 */
export function WikiBuildHere() {
 const { project } = useScope(), identity = useIdentity();
 const role = servedReadState(identity.read).data?.developer.orgRole;
 return <section aria-label="Build the wiki" data-testid="wiki-build-here" className="rv-wsr-buildhere">
  <WikiChecklistRow project={project} companyAdmin={role === "owner" || role === "admin"} alone startOpen />
 </section>;
}
