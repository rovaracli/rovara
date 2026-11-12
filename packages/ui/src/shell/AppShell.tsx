import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AppNavReaderSchema } from "@agentx/cloud-contracts/web";
import { createApiClient } from "../api/client.js";
import { reloadPage, useAppHost } from "../host.js";
import { Button } from "../design/Button.js";
import { Dialog } from "../design/Dialog.js";
import { Skeleton } from "../design/Skeleton.js";
import { VisibleText } from "../design/VisibleText.js";
import { SidebarV2, TabBar } from "./NavV2.js";
import { isCompanySwitcherOn } from "../company-flags.js";
import { CompanyGate, CompanyHeader, CompanyPhoneList } from "./company-lazy.js";
import { AccountMenu } from "./AccountMenu.js";
import { TrialBanner } from "./TrialBanner.js";
import { NamePrompt } from "./NamePrompt.js";
import { PageError } from "./ErrorBoundary.js";
export function AppShell() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), location = useLocation(), main = useRef<HTMLElement>(null);
 const [menu, setMenu] = useState(false), [switcher] = useState(() => isCompanySwitcherOn(host));
 const nav = useQuery({ queryKey: ["nav"], queryFn: () => api.get("/v1/app/nav", AppNavReaderSchema) });
 const ready = nav.data !== undefined;
 useEffect(() => { main.current?.querySelector<HTMLElement>("h1")?.focus(); }, [location.pathname, ready]);
 if (nav.isPending) return <Skeleton label="Loading workspace" />;
 if (nav.data === undefined) return <PageError error={nav.error} reload={() => { reloadPage(host); }} />;
 return <div className="rv-app-shell rv-nav-v2"><a className="rv-skip-link" href="#main">Skip to main content</a><header className="rv-shell-header"><span className="rv-wordmark">Rovara</span><Dialog title="Workspace" className="rv-workspace-menu" open={menu} onOpenChange={setMenu} trigger={<Button className="rv-mobile-menu" aria-label="Open workspace menu">Menu</Button>}>{menu && <>{switcher && <Suspense fallback={null}><CompanyPhoneList /></Suspense>}<SidebarV2 nav={nav.data} onNavigate={() => setMenu(false)} /></>}</Dialog>{switcher ? <Suspense fallback={<span className="rv-shell-org"><VisibleText text={nav.data.org.name} /></span>}><CompanyHeader name={nav.data.org.name} /></Suspense> : <span className="rv-shell-org"><VisibleText text={nav.data.org.name} /></span>}<AccountMenu nav={nav.data} /></header><aside className="rv-shell-sidebar"><SidebarV2 nav={nav.data} /></aside><main id="main" ref={main} tabIndex={-1} className="rv-shell-main"><NamePrompt me={nav.data.me} /><TrialBanner state={nav.data.org.trial?.state} />{switcher ? <Suspense fallback={<Skeleton label="Loading workspace" />}><CompanyGate currentName={nav.data.org.name}><Outlet /></CompanyGate></Suspense> : <Outlet />}</main><TabBar nav={nav.data} /></div>;
}
