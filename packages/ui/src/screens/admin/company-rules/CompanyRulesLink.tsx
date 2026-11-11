// A link to the read-only company rules, on the account page, for everyone while the install's switch `si` is on (the nav answer says so). Not part of the shared shell, so no other lane's file changes.
import { Link } from "react-router";
import { useNav } from "../../../api/nav.js";
export function CompanyRulesLink() {
 const nav = useNav();
 if (nav.data?.features.companyRules !== true) return null;
 return <section aria-label="Company rules"><h2>Company rules</h2><p>The standing instructions your company gives every Rovara agent.</p><Link to="/app/settings/company-rules">Read the company rules</Link></section>;
}
