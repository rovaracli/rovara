import { KF_POLICY as T } from "./company-text.js";
import { Fact, Row } from "../../rules-lessons-read/parts.js";

/** The fixed company explanation for known-failing marks, as a row of the company Rules page. There is no configurable approval count and nothing to press. */
export function KnownFailingPolicyRow() {
 return <Row label="Known failing tests"><Fact>{T.EXPLANATION}</Fact></Row>;
}
