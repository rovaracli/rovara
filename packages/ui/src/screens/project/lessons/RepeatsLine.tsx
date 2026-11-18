import { useCompanyLessonRepeats, useLessonRepeats } from "../../../api/lessons-extras.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { LearningMetric } from "../LearningMetric.js";

export function repeatWords(value: { repeated: number; corrections: number; enoughData: boolean }): string {
 if (value.corrections === 0) return "No corrections yet this month.";
 if (!value.enoughData) return `Not enough corrections yet this month (${value.corrections} so far; 10 needed).`;
 if (value.repeated === 0) return `No repeated corrections this month (${value.corrections} corrections).`;
 return `Corrections you had to repeat: ${value.repeated} of ${value.corrections} this month.`;
}
export function RepeatsLine({ project }: { project: string }) {
 const read = useLessonRepeats(project);
 if (!read.isSuccess) return null;
 return <p className="rv-muted" data-testid="lesson-repeats"><VisibleText text={repeatWords(read.data)} /></p>;
}
export function ProjectRepeatsMetric({ project, learning }: { project: string; learning: Parameters<typeof LearningMetric>[0]["learning"] }) {
 const read = useLessonRepeats(project);
 return read.isSuccess ? <section className="rv-project-section" aria-label="Repeated corrections"><h2>Repeated corrections</h2><p><strong><VisibleText text={repeatWords(read.data)} /></strong></p></section> : <LearningMetric project={project} learning={learning} />;
}
export function CompanyRepeatsLine({ enabled }: { enabled: boolean }) {
 const read = useCompanyLessonRepeats(enabled);
 if (!read.isSuccess) return null;
 const data = read.data, projects = Array.isArray(data.projects) ? data.projects.length : 0;
 return <p className="rv-muted" data-testid="company-repeats">Corrections people had to repeat: {data.repeated} of {data.corrections} this month, across {projects} projects.</p>;
}
