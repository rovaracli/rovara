import { Link } from "react-router";
import { COLLECTING_TEXT as T, collectingCount } from "./learning-text.js";

/** Shown in place of the empty state while the company's suggestions are off: Rovara keeps collecting corrections, and says where to turn suggestions on. */
export function LearningCollecting({ corrections }: { corrections: number }) {
 return <div className="rv-learning-collecting"><h3>{T.HEADING}</h3><p>{collectingCount(corrections)}</p><p className="rv-muted">{T.WHERE}<Link to="/app/admin/how-we-work">{T.LINK}</Link></p></div>;
}
