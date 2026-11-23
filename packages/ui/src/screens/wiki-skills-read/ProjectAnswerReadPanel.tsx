import { useContext } from "react";
import { Link } from "react-router";
import { useAnswersEnabled } from "../../api/answers.js";
import { useProject } from "../../api/projects.js";
import { AnswerBox } from "../answers/AnswerBox.js";
import "../answers/answers.css";
import { ReadSurfaceContext } from "./ReadState.js";
import { Card, Header, StaleLine, readClock } from "./parts.js";
import { useScope } from "./read-model.js";
/** Current answers API has no GET history, so no earlier answer is drawn and none is invented. Where this deployment offers answers and the person has a role on the project, the question card is the Ask box itself (same question, same answer view, same one "Start a Quick task" button); otherwise the card keeps one Unknown line. */
export function ProjectAnswerReadPanel({ readAt }: { readAt?: string | undefined }) {
 const { project } = useScope(), staleSince = useContext(ReadSurfaceContext)?.staleSince, answersOn = useAnswersEnabled(), overview = useProject(answersOn ? project : undefined);
 return <>
  <Header project={project} trail={["Wiki", "Ask"]} meta="Ask · answers come from this project's wiki and repo" readAt={staleSince === undefined ? readAt : undefined} always />
  {staleSince !== undefined && <StaleLine at={readClock(staleSince)} />}
  <div className="rv-wsr-back"><Link className="rv-button rv-button-quiet" to="?tab=wiki">Back to Wiki</Link></div>
  <div className="rv-wsr-page"><Card title={"Ask about " + project}>{answersOn && overview.data !== undefined ? <AnswerBox project={project} repositories={overview.data.project.repositories} canStart={overview.data.you.canStartWork} /> : <><p className="rv-wsr-body">Questions about this project are answered from its wiki and its code, and each answer names the files it rests on.</p><p className="rv-wsr-quiet">Existing answer: Can&apos;t tell yet.</p></>}</Card></div>
 </>;
}
