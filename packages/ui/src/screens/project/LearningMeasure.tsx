import { useLessonMeasure } from "../../api/lessons.js";
import { ApiError } from "../../api/errors.js";

/** The read itself is the permission check: Code returns this only to a maintainer or company administrator. */
export function LearningMeasure({ project, canSeeLessonsOff = false }: { project: string; canSeeLessonsOff?: boolean }) {
 const measure = useLessonMeasure(project);
 if (measure.data === undefined) {
  if (!measure.isError) return null;
  if (measure.error instanceof ApiError && (measure.error.status === 403 || measure.error.status === 404)) {
   if (canSeeLessonsOff && measure.error.status === 404 && measure.error.code === "LESSONS_SWITCHED_OFF") return <p className="rv-muted" role="status">Lessons are off.</p>;
   return null;
  }
  const words = measure.error instanceof ApiError ? measure.error.message : "Lessons measure is unavailable right now. Try again.";
  return <section className="rv-project-section" aria-labelledby="lessons-measure-title"><h2 id="lessons-measure-title">Lessons measure</h2><p role="status">{words}</p></section>;
 }
 const value = measure.data;
 const rate = value.cleanMerge.rate === null ? "No merged tasks in this window." : `${Math.round(value.cleanMerge.rate * 100)}% clean merges (${value.cleanMerge.clean} of ${value.cleanMerge.merged})`;
 return <section className="rv-project-section" aria-labelledby="lessons-measure-title">
  <h2 id="lessons-measure-title">Lessons measure</h2>
  <p>Last {value.windowDays} days · fit floor {value.floor.toFixed(2)}</p>
  <ul>
   <li>{value.meanFitLoaded === null ? "No loaded lesson fit scores yet." : `Mean loaded fit ${value.meanFitLoaded.toFixed(3)}`}</li>
   <li>{value.meanFitLeftOut === null ? "No left out lesson fit scores yet." : `Mean left out fit ${value.meanFitLeftOut.toFixed(3)}`}</li>
   <li>{value.loadedBelowFloor} loaded below the fit floor</li>
   <li>{rate}</li>
   <li>{value.revertDetection === "not_wired" ? "Revert detection isn't wired yet." : "Revert detection is available."}</li>
  </ul>
  {(value.truncated || value.unreadable > 0) && <p className="rv-muted">This summary may be incomplete.</p>}
 </section>;
}
