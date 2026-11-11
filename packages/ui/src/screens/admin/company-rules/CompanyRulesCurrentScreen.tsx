// The company rules in force, read only, for any member (switch `si`; `GET /v1/app/org/company-rules/current`). Nothing here changes anything: owners and admins change the rules in company settings.
import { ApiError } from "../../../api/errors.js";
import { useCompanyRulesCurrent } from "../../../api/company-rules.js";
import { Button } from "../../../design/Button.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { T } from "./company-rules-text.js";
import { formatDay } from "./format.js";
import { RulesList } from "./parts.js";
import { toRules } from "./rules-logic.js";
import "./company-rules.css";

export function CompanyRulesCurrentScreen() {
 const read = useCompanyRulesCurrent();
 if (read.isPending) return <section aria-label={T.TITLE} aria-busy="true"><Skeleton label="Loading the company rules" /></section>;
 if (read.error instanceof ApiError && read.error.status === 404) return <section><PageHeader focusOnMount title={T.TITLE} description={T.INTRO} /><p role="status">{T.SWITCHED_OFF_MEMBER}</p></section>;
 if (read.data === undefined) return <section><PageHeader focusOnMount title={T.TITLE} /><p role="alert"><VisibleText text={read.error instanceof ApiError ? read.error.message : T.LOAD_FAILED} /></p><div><Button onClick={() => { void read.refetch(); }}>{T.RETRY}</Button></div></section>;
 const current = read.data.current;
 return <section aria-label={T.TITLE} className="rv-cr"><PageHeader focusOnMount title={T.TITLE} description={T.INTRO} />
  <p className="rv-cr-rank"><strong>{T.RANK_HEADING}.</strong> {T.RANK}</p>
  <section aria-labelledby="cr-current" className="rv-cr-card"><h2 id="cr-current">{T.CURRENT_HEADING}</h2>
   {current === null || current.rules.length === 0 ? <p>{T.NONE_YET}</p> : <>
    <p><strong>Version {current.version}</strong> on {formatDay(current.approvedAt)}.</p>
    <RulesList rules={toRules(current.rules)} label="Current rules" />
   </>}
  </section>
  <p className="rv-muted">{T.MEMBER_READ_ONLY}</p>
 </section>;
}
