// The outermost boundary of the app (decision 125 follow-up). Its own file, imported only by App, so the lazy screens that share ErrorBoundary.tsx do not share the theme with it.
import { useLayoutEffect, type ReactNode } from "react";
import { reloadPage, type AppHost } from "../host.js";
import { ThemeSheet } from "../theme.js";
import { ErrorBoundary, PageError } from "./ErrorBoundary.js";
// The outermost boundary's page brings the token sheet itself (ThemeSheet, the same one ThemeProvider writes), so it is styled even when ThemeProvider is what failed.
const APP_ERROR_CSS = ".rv-app-error{min-height:100dvh;background:var(--rv-bg);color:var(--rv-text);font-family:var(--rv-font-ui)}.rv-app-error .rv-wordmark{display:block;padding:20px 24px}";
/** What App shows when anything above or around the router fails (the theme, the announcer, the router itself): the Rovara mark, the page error and Reload, in the one look. */
export function AppErrorPage({ error, reload }: { error: unknown; reload: () => void }) {
 useLayoutEffect(() => { document.documentElement.setAttribute("data-look", "v2"); }, []);
 return <div className="rv-app-error"><ThemeSheet extra={APP_ERROR_CSS} /><span className="rv-wordmark">Rovara</span><main><PageError error={error} reload={reload} /></main></div>;
}
export function AppErrorBoundary({ host, children }: { host: AppHost; children: ReactNode }) {
 const reload = () => { reloadPage(host); };
 return <ErrorBoundary reload={reload} fallback={error => <AppErrorPage error={error} reload={reload} />}>{children}</ErrorBoundary>;
}
