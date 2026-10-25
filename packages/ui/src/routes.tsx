import { HomeScreen } from "./screens/home/HomeScreen.js";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams, type RouteObject } from "react-router";
import { AppMeResponseReaderSchema, type AppNav } from "@agentx/contracts/web";
import { useAppHost } from "./host.js";
import { ApiError } from "./api/errors.js";
import { createApiClient } from "./api/client.js";
import { Button } from "./design/Button.js";
import { Skeleton } from "./design/Skeleton.js";
import { AppShell } from "./shell/AppShell.js";
import { NotFound } from "./shell/NotFound.js";
import { RouteError } from "./shell/ErrorBoundary.js";
import { VisibleText } from "./design/VisibleText.js";
function Page({ title }: { title: string }) { return <section><h1 tabIndex={-1}>{title}</h1></section>; }
function Signup() { const host = useAppHost();return <main className="rv-entry"><h1 tabIndex={-1}>Start working together</h1><p>Bring your team's methods and work into one shared workspace.</p><Button variant="primary" onClick={() => host.signIn("/app/welcome")}>Continue</Button></main>; }
function SignedOut() {
 const host = useAppHost(), [params] = useSearchParams();
 const reason = params.get("reason"), message = reason === "removed" ? "Your access to this organization ended." : reason === "failed" ? "We couldn't finish signing you in. Try again." : reason === "cancelled" ? "Sign-in was cancelled." : "You've signed out.";
 return <main className="rv-entry"><h1 tabIndex={-1}>Sign in to Rovara</h1><p>{message}</p><Button variant="primary" onClick={() => host.signIn("/app")}>Sign in</Button></main>;
}
function Welcome() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const me = useQuery({ queryKey: ["me"], queryFn: () => api.get("/v1/app/me", AppMeResponseReaderSchema) });
 if (me.isPending) return <main className="rv-entry"><Skeleton label="Loading your account" /></main>;
 if (me.data === undefined) return <main className="rv-entry"><h1>Couldn't load your account</h1>{me.error instanceof ApiError && <p role="alert"><VisibleText text={me.error.message} /></p>}<Button onClick={() => { void me.refetch(); }}>Try again</Button></main>;
 return <main className="rv-entry"><h1 tabIndex={-1}>Welcome, <VisibleText text={me.data.developer.name} /></h1><Button variant="primary" onClick={() => host.navigate("/app")}>Open workspace</Button></main>;
}
export function appRoutes(features: AppNav["features"]): RouteObject[] {
 const children: RouteObject[] = [
 { index: true, element: <HomeScreen /> }, { path: "live", lazy: async () => ({ Component: (await import("./screens/live/LiveScreen.js")).LiveScreen }) },
 { path: "projects/:name", lazy: async () => ({ Component: (await import("./screens/project/ProjectScreen.js")).ProjectScreen }) }, { path: "sessions/:id", lazy: async () => ({ Component: (await import("./screens/session/SessionScreen.js")).SessionScreen }) },
 { path: "agents/:id?", lazy: async () => ({ Component: (await import("./screens/agents/DirectoryScreen.js")).DirectoryScreen }) }, { path: "agents/new", lazy: async () => ({ Component: (await import("./screens/builder/NewAgentScreen.js")).NewAgentScreen }) },
 { path: "agents/:id/edit", lazy: async () => ({ Component: (await import("./screens/builder/BuilderScreen.js")).BuilderScreen }) },
 { path: "onboard", element: <Page title="Onboard a project" /> },
 ];
 // Part B owns these screen implementations. Disabled routes are absent, including direct URLs.
 if (features.usage) children.push({ path: "usage", element: <Page title="Usage" /> });
 if (features.admin) children.push({ path: "admin/*", handle: { webOnly: true }, element: <Page title="Administration" /> });
 if (features.chains) children.push({ path: "chains/*", element: <Page title="Chains" /> });
 if (features.describe) children.push({ path: "describe", element: <Page title="Describe an agent" /> });
 children.push({ path: "*", element: <NotFound /> });
 return [{ path: "/s/:id", element: <AppShell />, errorElement: <RouteError />, children: [{ index: true, lazy: async () => ({ Component: (await import("./screens/session/SessionScreen.js")).SessionScreen }) }] }, { path: "/app/signup", element: <Signup />, errorElement: <RouteError /> }, { path: "/app/welcome", element: <Welcome />, errorElement: <RouteError /> }, { path: "/app/signed-out", element: <SignedOut />, errorElement: <RouteError /> }, { path: "/app", element: <AppShell />, errorElement: <RouteError />, children }, { path: "*", element: <NotFound /> }];
}
