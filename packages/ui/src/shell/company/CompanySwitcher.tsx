// The company switcher (lane exp/company-switcher, switch: company-flags.ts). This whole file is a lazy chunk (company-lazy.tsx): off, none of it is downloaded.
// Three pieces: the header (the company name, a menu of companies once there are two), the same list inside the phone's Menu, and the gate that stops a page
// from showing one company's screen under another's name (a link for another company, or an answer that names one).
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { DropdownMenu as R } from "radix-ui";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { VisuallyHidden } from "../../design/VisuallyHidden.js";
import { ApiError } from "../../api/errors.js";
import { COMPANY_ROLE_WORDS, linkCompany, useCompanies, useSwitchCompany, withoutLinkCompany, type Company } from "../../api/companies.js";
import { clearCompanyMismatch, companyMismatch, pageCompany, subscribeCompanyMismatch } from "../../api/company-context.js";
/** The server's own sentence when it has one (a refused switch, a machine credential); otherwise one plain sentence. */
const sentence = (error: unknown) => error instanceof ApiError ? error.message : "Couldn't switch company. Try again.";
/** One switch in flight, and what it said when it was refused. The page reloads on success, so success needs no state. */
function useSwitching() {
 const run = useSwitchCompany(), [busy, setBusy] = useState<string>(), [error, setError] = useState<string>();
 /** Resolves true when the switch was refused (the sentence is in `error`); on success the page is already reloading. */
 async function choose(companyId: string, destination?: string): Promise<boolean> {
  setBusy(companyId);setError(undefined);
  try { await run(companyId, destination);return false; } catch (caught) { setError(sentence(caught));setBusy(undefined);return true; }
 }
 return { busy, error, choose, clear: () => { setError(undefined); } };
}
function Check() { return <span className="rv-company-check" aria-hidden="true"><R.ItemIndicator>✓</R.ItemIndicator></span>; }
function Row({ company }: { company: Company }) { return <span className="rv-company-text"><span className="rv-company-name"><VisibleText text={company.name} /></span><span className="rv-company-role">{COMPANY_ROLE_WORDS[company.role]}{company.status === "closing" ? ", closing" : ""}</span></span>; }
/** The header's company area. One company (or none read yet): the name exactly as before, no button. Two or more: the name is a button that opens the menu. */
export function CompanyHeader({ name }: { name: string }) {
 const companies = useCompanies(), switching = useSwitching(), [open, setOpen] = useState(false), nameButton = useRef<HTMLButtonElement>(null), list = companies.data?.companies ?? [], active = companies.data?.activeCompanyId;
 if (list.length < 2 || active === undefined) return <span className="rv-shell-org"><VisibleText text={name} /></span>;
 // A refusal closes the menu and says why in a small dialog: a menu may hold only its items, so the server's sentence cannot sit inside it, and the dialog returns focus to the name when it closes.
 return <span className="rv-shell-org"><R.Root modal={false} open={open} onOpenChange={setOpen}>
  <R.Trigger asChild><button type="button" ref={nameButton} className="rv-company-button"><VisibleText text={name} /><VisuallyHidden>, switch company</VisuallyHidden><span className="rv-company-chevron" aria-hidden="true">▾</span></button></R.Trigger>
  <R.Portal><R.Content className="rv-popover rv-company-menu" align="start" sideOffset={4}>
   <R.RadioGroup value={active}>{list.map(company => <R.RadioItem key={company.companyId} value={company.companyId} disabled={switching.busy !== undefined} className="rv-menu-item rv-company-item" onSelect={event => { if (company.companyId !== active) { event.preventDefault();void switching.choose(company.companyId).then(failed => { if (failed) setOpen(false); }); } }}><Row company={company} /><Check /></R.RadioItem>)}</R.RadioGroup>
  </R.Content></R.Portal></R.Root>
  <Dialog title="Couldn't switch company" onCloseAutoFocus={event => { event.preventDefault();nameButton.current?.focus(); }} open={switching.error !== undefined} onOpenChange={next => { if (!next) switching.clear(); }}><p role="alert"><VisibleText text={switching.error ?? ""} /></p></Dialog></span>;
}
/** The same list inside the phone's Menu (the old shell's and the new navigation's share it): 44px rows, the current company marked. Nothing with fewer than two companies. */
export function CompanyPhoneList() {
 const companies = useCompanies(), switching = useSwitching(), heading = useId(), list = companies.data?.companies ?? [], active = companies.data?.activeCompanyId;
 if (list.length < 2 || active === undefined) return null;
 return <section className="rv-company-list" aria-labelledby={heading}><h2 id={heading}>Company</h2><ul>{list.map(company => <li key={company.companyId}><button type="button" className="rv-company-row" aria-current={company.companyId === active ? "true" : undefined} disabled={switching.busy !== undefined} onClick={() => { if (company.companyId !== active) void switching.choose(company.companyId); }}><Row company={company} />{company.companyId === active && <span className="rv-company-check" aria-hidden="true">✓</span>}</button></li>)}</ul>{switching.error !== undefined && <p role="alert" className="rv-company-error"><VisibleText text={switching.error} /></p>}</section>;
}
/**
 * Never shows a screen under the wrong company. A link that names another company (`?company=org_...`), or an answer that did, stops here with a question:
 * "This link is for <Company B>. Switch to Company B?" (Switch or Stay). A company the person is not in gets one generic sentence that never says whether it exists.
 * With no such company this renders its children at once; it does not wait for the companies read.
 */
export function CompanyGate({ children, currentName }: { children: ReactNode; currentName: string }) {
 const host = useAppHost(), location = useLocation(), navigate = useNavigate(), companies = useCompanies(), switching = useSwitching(), heading = useRef<HTMLHeadingElement>(null);
 const mismatch = useSyncExternalStore(listener => subscribeCompanyMismatch(host.transport, listener), () => companyMismatch(host.transport));
 const link = linkCompany(location.search), active = companies.data?.activeCompanyId ?? pageCompany(host.transport);
 const target = mismatch ?? (link !== undefined && link !== active ? link : undefined);
 const state = target === undefined ? "open" : companies.isPending ? "checking" : companies.data === undefined ? "unknown" : companies.data.companies.some(company => company.companyId === target) ? "ask" : "denied";
 useEffect(() => { if (state !== "open" && state !== "checking") heading.current?.focus(); }, [state, target]);
 if (state === "open") return <>{children}</>;
 if (state === "checking") return <Skeleton label="Checking this link" />;
 const other = companies.data?.companies.find(company => company.companyId === target);
 const stay = () => { if (mismatch !== undefined) { clearCompanyMismatch(host.transport);try { host.navigate(host.currentPath()); } catch { host.navigate("/app"); } } else void navigate(withoutLinkCompany(location.pathname, location.search, location.hash), { replace: true }); };
 if (state === "unknown") return <section className="rv-company-gate"><h1 ref={heading} tabIndex={-1}>We couldn't check which company this is for</h1><p>Go to Home and open the link again. Nothing from another company is shown meanwhile.</p><div className="rv-company-gate-actions"><Button variant="primary" onClick={() => { host.navigate("/app"); }}>Go to Home</Button></div></section>;
 if (state === "denied" || other === undefined) return <section className="rv-company-gate"><h1 ref={heading} tabIndex={-1}>You don't have access to this link</h1><p>Ask the person who sent it, or go back to Home.</p><div className="rv-company-gate-actions"><Button variant="primary" onClick={stay}>Go to Home</Button></div></section>;
 const destination = mismatch === undefined ? withoutLinkCompany(location.pathname, location.search, location.hash) : "/app";
 return <section className="rv-company-gate" aria-labelledby="rv-company-gate-title"><h1 id="rv-company-gate-title" ref={heading} tabIndex={-1}>{mismatch === undefined ? "This link is for " : "This page is for "}<VisibleText text={other.name} />. Switch to <VisibleText text={other.name} />?</h1><p>Your work in <VisibleText text={currentName} /> stays as it is.</p><div className="rv-company-gate-actions"><Button variant="primary" busy={switching.busy !== undefined} onClick={() => { void switching.choose(other.companyId, destination); }}>Switch</Button><Button disabled={switching.busy !== undefined} onClick={stay}>Stay</Button></div>{switching.error !== undefined && <p role="alert"><VisibleText text={switching.error} /></p>}</section>;
}
