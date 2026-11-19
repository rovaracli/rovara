import { useCompanyLessonRepeats, useLessonRepeats } from "../../../api/lessons-extras.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { LearningMetric } from "../LearningMetric.js";

export function repeatWords(value: { repeated: number; corrections: number; enoughData: boolean; truncated?: boolean | undefined }): string {
 if (value.corrections === 0) return "No corrections yet this month.";
 if (!value.enoughData) return `Not enough corrections yet this month (${value.corrections} so far; 10 needed).`;
 const counted = value.truncated === true ? " (first 2,000 corrections counted)" : "";
 if (value.repeated === 0) return `No repeated corrections this month (${value.corrections} corrections)${counted}.`;
 return `Corrections you had to repeat: ${value.repeated} of ${value.corrections} this month${counted}.`;
}
/** The company's one line on the Admin overview: the same four cases, with the project count and a note when the sum stopped early. */
export function companyRepeatWords(value: { repeated: number; corrections: number; enoughData: boolean; projects: number; truncated?: boolean | undefined }): string {
 const across = `${value.projects} ${value.projects === 1 ? "project" : "projects"}`, partial = value.truncated === true ? " Some projects are not counted yet." : "";
 if (value.corrections === 0) return `No corrections yet this month.${partial}`;
 if (!value.enoughData) return `Not enough corrections yet this month (${value.corrections} so far; 10 needed).${partial}`;
 if (value.repeated === 0) return `No corrections people had to repeat this month (${value.corrections} corrections, across ${across}).${partial}`;
 return `Corrections people had to repeat: ${value.repeated} of ${value.corrections} this month, across ${across}.${partial}`;
}
export function RepeatsLine({ project }: { project: string }) {
 const read = useLessonRepeats(project);
 if (!read.isSuccess) return null;
 return <p className="rv-muted" data-testid="lesson-repeats"><VisibleText text={repeatWords({ repeated: read.data.repeated, corrections: read.data.corrections, enoughData: read.data.enoughData, truncated: read.data.truncated })} /></p>;
}
export function ProjectRepeatsMetric({ project, learning }: { project: string; learning: Parameters<typeof LearningMetric>[0]["learning"] }) {
 const read = useLessonRepeats(project);
 return read.isSuccess ? <section className="rv-project-section" aria-label="Repeated corrections"><h2>Repeated corrections</h2><p><strong><VisibleText text={repeatWords({ repeated: read.data.repeated, corrections: read.data.corrections, enoughData: read.data.enoughData, truncated: read.data.truncated })} /></strong></p></section> : <LearningMetric project={project} learning={learning} />;
}
export function CompanyRepeatsLine({ enabled }: { enabled: boolean }) {
 const read = useCompanyLessonRepeats(enabled);
 if (!read.isSuccess) return null;
 const data = read.data, projects = Array.isArray(data.projects) ? data.projects.length : 0;
 return <p className="rv-muted" data-testid="company-repeats">{companyRepeatWords({ repeated: data.repeated, corrections: data.corrections, enoughData: data.enoughData, projects, truncated: data.truncated })}</p>;
}
