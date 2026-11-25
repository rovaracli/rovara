import { ApiError } from "../../api/errors.js";
import { useSavedEnvPanel } from "../../api/saved-env.js";
import { Button } from "../../design/Button.js";
import { Skeleton } from "../../design/Skeleton.js";
import { ENV as T, failureText, healthText, imageText, lastReasonText, rebuildText } from "./environment-panel-text.js";
import "./learning.css";

/**
 * The project's saved environment (SH26): its health, how old the saved copy is, and why the last rebuild was started. Every sentence is a fixed one; the server sends words, counts and times.
 * Where saved environments are not on (the route answers 404) the panel shows nothing at all; where Cloud answers 501 NOT_ON_CODE_YET it is one plain muted line. A read that fails otherwise is a quiet sentence with Try again, not an alert: the panel is a secondary part of the page. There is no Reset: hosted Rovara Code never lets anyone reset (`canReset` is always false there) and Cloud does not forward it, so no Reset button and no sentence about who could press it is ever drawn (DEC 540).
 */
export function EnvironmentPanel({ project }: { project: string }) {
 const read = useSavedEnvPanel(project);
 if (read.isPending) return <section className="rv-project-section rv-learning" aria-label={T.HEADING}><Skeleton label={T.LOADING} /></section>;
 if (read.error instanceof ApiError && (read.error.status === 404 || read.error.status === 403)) return null;
 // Cloud answers 501 NOT_ON_CODE_YET while Rovara Code does not serve saved environments: a designed absence, one plain muted line, never an error and never Try again.
 if (read.error instanceof ApiError && (read.error.status === 501 || read.error.code === "NOT_ON_CODE_YET")) return <section className="rv-project-section rv-learning" aria-label={T.HEADING}><h2>{T.HEADING}</h2><p className="rv-muted">{T.NOT_AVAILABLE}</p></section>;
 if (read.data === undefined) return <section className="rv-project-section rv-learning" aria-label={T.HEADING}><h2>{T.HEADING}</h2><p>{T.LOAD_FAILED}</p><Button onClick={() => { void read.refetch(); }}>{T.TRY_AGAIN}</Button></section>;
 const panel = read.data;
 return <section className="rv-project-section rv-learning" aria-label={T.HEADING}>
  <h2>{T.HEADING}</h2>
  <p className="rv-muted">{T.HELP}</p>
  <p><strong>{healthText(panel.health)}</strong></p>
  <p>{panel.image === undefined ? T.NO_IMAGE : imageText(panel.image)}</p>
  {panel.rebuild !== undefined && <p>{rebuildText(panel.rebuild)}</p>}
  {panel.lastRebuildReason !== undefined && <p className="rv-muted">{lastReasonText(panel.lastRebuildReason)}</p>}
  {panel.lastFailure !== undefined && <p className="rv-muted">{failureText(panel.lastFailure)}</p>}
 </section>;
}
