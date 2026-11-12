// UX3: the company settings navigation, in the same groups as the overview. On a phone it is one closed list under a "Menu" button, so the page itself starts at the top.
import { useId, useState } from "react";
import { NavLink } from "react-router";
import { useNav } from "../../api/nav.js";
import { visibleSections } from "./admin-sections.js";
export function AdminNav({ role, secondReviewOff, companyAdmin, compact, billingOn = false, approvalWindowOff = false, privateAddressesOff = false }: { role: "owner" | "admin" | "member"; secondReviewOff: boolean; companyAdmin: boolean; compact: boolean; billingOn?: boolean; approvalWindowOff?: boolean; privateAddressesOff?: boolean }) {
  const [open, setOpen] = useState(false), list = useId(), nav = useNav();
  // Company rules is listed only while the nav answer says its switch (`si`) is on.
  const sections = companyAdmin ? visibleSections(role, secondReviewOff, billingOn, nav.data?.features.companyRules === true, approvalWindowOff, privateAddressesOff) : [];
  const links = <>
    {companyAdmin && <NavLink to="/app/admin" end onClick={() => { setOpen(false); }}>Overview</NavLink>}
    {sections.map(section => <div key={section.id} role="group" aria-label={section.title} className="rv-admin-nav-group"><p className="rv-admin-nav-heading" aria-hidden="true">{section.title}</p>{section.items.map(item => <NavLink key={item.to} to={item.to} onClick={() => { setOpen(false); }}>{item.label}</NavLink>)}</div>)}
    <NavLink to="/app/admin/waiting" onClick={() => { setOpen(false); }}>Waiting for people</NavLink>
  </>;
  return <nav aria-label="Administration" className="rv-admin-nav" data-compact={compact || undefined}>
    {compact && <button type="button" className="rv-button rv-button-secondary rv-admin-nav-toggle" aria-expanded={open} aria-controls={list} onClick={() => { setOpen(!open); }}>{open ? "Hide settings menu" : "Settings menu"}</button>}
    <div id={list} className="rv-admin-nav-list" hidden={compact && !open}>{links}</div>
  </nav>;
}
