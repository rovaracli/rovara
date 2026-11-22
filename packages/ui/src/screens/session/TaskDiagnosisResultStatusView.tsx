import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;

type Props =
 | { state: "unconfirmed"; onCheck: () => void }
 | { state: "unavailable"; onCheck: () => void }
 | { state: "empty"; safeReference?: string };

/** Read-only diagnosis outcomes. The session owner supplies the current read state and owns every request. */
export function TaskDiagnosisResultStatusView(props: Props) {
 if (props.state === "unconfirmed") return <div className="rv-fix-with-agent" data-testid="diagnosis-result-status" role="status">
  <p>The diagnosis was not confirmed. The failed task has not been repaired by this request.</p>
  <Button variant="quiet" onClick={props.onCheck}>Check this diagnosis request</Button>
 </div>;

 if (props.state === "unavailable") return <div className="rv-fix-with-agent" data-testid="diagnosis-result-status" role="alert">
  <p>The diagnosis could not be read. No repair is authorized by this read.</p>
  <Button variant="quiet" onClick={props.onCheck}>Check this diagnosis</Button>
 </div>;

 return <div className="rv-fix-with-agent" data-testid="diagnosis-result-status" role="status">
  <p>Rovara found no suggested repair. This has not changed the task.</p>
  {props.safeReference !== undefined && SAFE_REFERENCE.test(props.safeReference) && <p className="rv-muted">Contact support with this error’s reference: <VisibleText text={props.safeReference} /></p>}
 </div>;
}
