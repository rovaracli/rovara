import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useMatches } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AppNavReaderSchema } from "@agentx/contracts/web";
import { createApiClient } from "../api/client.js";
import { useAppHost } from "../host.js";
import { Button } from "../design/Button.js";
import { Dialog } from "../design/Dialog.js";
import { Skeleton } from "../design/Skeleton.js";
import { VisibleText } from "../design/VisibleText.js";
import { Sidebar } from "./Sidebar.js";
import { AccountMenu } from "./AccountMenu.js";
import { TrialBanner } from "./TrialBanner.js";
import { NamePrompt } from "./NamePrompt.js";
// Guided onboarding PR 13: the admins' "connection needs attention" banner, its own chunk. Web app only (Connections lives in the web admin area), and not inside
// the admin area, where Company settings, Connections already shows the same state.
const IntegrationBanner = lazy(async () => ({ default: (await import("../screens/connect/integration-notices.js")).IntegrationBanner }));
import { PageError } from "./ErrorBoundary.js";
export function AppShell() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), location = useLocation(), main = useRef<HTMLElement>(null);
 const [menu, setMenu] = useState(false), bleed = useMatches().some(match => (match.handle as { bleed?: boolean } | undefined)?.bleed === true);
 const nav = useQuery({ queryKey: ["nav"], queryFn: () => api.get("/v1/app/nav", AppNavReaderSchema) });
 const ready = nav.data !== undefined;
 const sheet = location.pathname === "/app/design-system";
 useEffect(() => { main.current?.querySelector<HTMLElement>("h1")?.focus(); }, [location.pathname, ready]);
 if (nav.isPending) return <Skeleton label="Loading workspace" />;
 if (nav.data === undefined) return <PageError error={nav.error} reload={() => host.navigate(host.currentPath())} />;
 return <div className={`rv-app-shell${sheet ? " rv-shell-sheet" : ""}`}><a className="rv-skip-link" href="#main">Skip to main content</a><header className="rv-shell-header"><span className="rv-wordmark"><i aria-hidden="true" />Rovara</span><Dialog title="Workspace" className="rv-workspace-menu" open={menu} onOpenChange={setMenu} trigger={<Button className="rv-mobile-menu" aria-label="Open workspace menu">Menu</Button>}>{menu && <Sidebar nav={nav.data} onNavigate={() => setMenu(false)} />}</Dialog><span className="rv-shell-org"><VisibleText text={nav.data.org.name} /></span><AccountMenu nav={nav.data} /></header><aside className="rv-shell-sidebar"><Sidebar nav={nav.data} /></aside><main id="main" ref={main} tabIndex={-1} className="rv-shell-main" {...(bleed ? { "data-bleed": "true" } : {})}><NamePrompt me={nav.data.me} /><TrialBanner state={nav.data.org.trial?.state} /><Suspense fallback={null}><IntegrationBanner admin={host.kind === "web" && !location.pathname.startsWith("/app/admin") && (nav.data.me.orgRole === "owner" || nav.data.me.orgRole === "admin")} /></Suspense><Outlet /></main></div>;
}
