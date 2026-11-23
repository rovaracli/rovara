import { Link } from "react-router";
import { useReadContext } from "./ReadEntry.js";
import { Block, Fact, Held, Row, Rows, ReadHeader } from "./parts.js";
import { KnownFailingPolicyRow } from "../admin/how-we-work/KnownFailingPolicyRow.js";
export function CompanyRulesReadScreen() {
 const { orgName } = useReadContext();
 return <div className="g4-page"><ReadHeader crumbs={["Company"]} title="Rules" />
  <Block title={`Rules for every project in ${orgName}`} className="g4-rules-block"><Rows>
   <KnownFailingPolicyRow />
   <Row label="Project instructions"><Fact>Instructions in a project&#8217;s repo apply only to that project.</Fact><Fact>A project&#8217;s How we work page explains its repository instructions and the checks that apply.</Fact></Row>
   <Row label="Other company rules"><Held>We can&#8217;t tell yet. Company locks and editing aren&#8217;t available here.</Held></Row>
  </Rows>
  <p className="g4-quiet g4-foot">Project rules are on each project&#8217;s How we work page, which says that these apply on top. A task keeps the versions it started with. <Link to="/app/admin/ai-spending#ai-models">Back to AI models</Link></p></Block></div>;
}
