import { useGraduation, lessonsOff, notServed, useLessonPages } from "../../../api/learned.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { ApiError } from "../../../api/errors.js";
import { DraftTasks } from "./DraftTasks.js";
import { GraduationCardView } from "./GraduationCardView.js";
import { TidyCardView } from "./TidyCardView.js";

/**
 * "This week" (lessons phase 4): at most one "Make this permanent?" card, the tidy card and the draft tasks, on top of Learned, for people who decide only (Code says who).
 * Everyone else sees nothing here; while there is nothing to decide the area is not drawn at all.
 */
export function ThisWeek({ project }: { project: string }) {
  const approved = useLessonPages(project, "approved"), canDecide = approved.data?.pages[0]?.canDecide === true;
  const read = useGraduation(project, canDecide);
  if (!canDecide) return null;
  if (read.isPending) return <Skeleton label="Loading this week" />;
  if (read.isError) {
    // Lessons off, an older Code, or a person Code does not let decide: quiet. Anything else is said.
    if (lessonsOff(read.error) || notServed(read.error) || (read.error instanceof ApiError && read.error.status === 403)) return null;
    return <p role="alert" className="rv-lesson-failed"><VisibleText text={read.error instanceof ApiError ? read.error.message : "Couldn't load this week's lessons."} /></p>;
  }
  const { canDecide: decides, card, tidy, drafts } = read.data;
  if (!decides || (card === undefined && tidy === undefined && drafts.length === 0)) return null;
  return <section className="rv-thisweek" aria-labelledby="this-week-title" data-testid="this-week">
    <h3 id="this-week-title">This week</h3>
    {card !== undefined && <GraduationCardView key={card.lessonId + ":" + String(card.version)} project={project} card={card} />}
    {tidy !== undefined && <TidyCardView project={project} tidy={tidy} />}
    <DraftTasks project={project} drafts={drafts} />
  </section>;
}
