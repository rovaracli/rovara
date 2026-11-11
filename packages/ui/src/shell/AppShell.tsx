import { useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AppNavReaderSchema } from "@agentx/cloud-contracts/web";
import { createApiClient } from "../api/client.js";
import { useAppHost } from "../host.js";
import { Button } from "../design/Button.js";
import { Dialog } from "../design/Dialog.js";
import { Skeleton } from "../design/Skeleton.js";
import { VisibleText } from "../design/VisibleText.js";
import { Sidebar } from "./Sidebar.js";
import { SidebarV2, TabBar } from "./NavV2.js";
import { isNewNavOn } from "../nav-flags.js";
import { AccountMenu } from "./AccountMenu.js";
import { TrialBanner } from "./TrialBanner.js";
import { NamePrompt } from "./NamePrompt.js";
import { PageError } from "./ErrorBoundary.js";
export function AppShell() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), location = useLocation(), main = useRef<HTMLElement>(null);
 const [menu, setMenu] = useState(false), [newNav] = useState(() => isNewNavOn(host));
 const nav = useQuery({ queryKey: ["nav"], queryFn: () => api.get("/v1/app/nav", AppNavReaderSchema) });
 const ready = nav.data !== undefined;
 useEffect(() => { main.current?.querySelector<HTMLElement>("h1")?.focus(); }, [location.pathname, ready]);
 if (nav.isPending) return <Skeleton label="Loading workspace" />;
 if (nav.data === undefined) return <PageError error={nav.error} reload={() => host.navigate(host.currentPath())} />;
 return <div className={newNav ? "rv-app-shell rv-nav-v2" : "rv-app-shell"}><a className="rv-skip-link" href="#main">Skip to main content</a><header className="rv-shell-header"><span className="rv-wordmark">Rovara</span><Dialog title="Workspace" className="rv-workspace-menu" open={menu} onOpenChange={setMenu} trigger={<Button className="rv-mobile-menu" aria-label="Open workspace menu">Menu</Button>}>{menu && (newNav ? <SidebarV2 nav={nav.data} onNavigate={() => setMenu(false)} /> : <Sidebar nav={nav.data} onNavigate={() => setMenu(false)} />)}</Dialog><span className="rv-shell-org"><VisibleText text={nav.data.org.name} /></span><AccountMenu nav={nav.data} /></header><aside className="rv-shell-sidebar">{newNav ? <SidebarV2 nav={nav.data} /> : <Sidebar nav={nav.data} />}</aside><main id="main" ref={main} tabIndex={-1} className="rv-shell-main"><NamePrompt me={nav.data.me} /><TrialBanner state={nav.data.org.trial?.state} /><Outlet /></main>{newNav && <TabBar nav={nav.data} />}</div>;
}
