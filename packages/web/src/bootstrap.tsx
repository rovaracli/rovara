import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { setNonce } from "get-nonce";
import { configureZodForCsp } from "@agentx/cloud-contracts/web";
import { App, PageError, ThemeProvider, type AppRouterFactory } from "@agentx/ui";
import { createBrowserHost } from "./browser-host.js";
type WebWindow = Window & Pick<typeof globalThis, "URL" | "WebSocket">;
const createRouter: AppRouterFactory = routes => createBrowserRouter(routes);
function WebRoot({ win }: { win: WebWindow }) {
 const [host] = useState(() => createBrowserHost(win)), [error, setError] = useState<unknown>();
 useEffect(() => { const receive = (event: Event) => { event.preventDefault();setError(new TypeError("Failed to fetch dynamically imported module")); };win.addEventListener("vite:preloadError", receive);return () => win.removeEventListener("vite:preloadError", receive); }, [win]);
 return error === undefined ? <App host={host} createRouter={createRouter} /> : <ThemeProvider host={host}><PageError error={error} reload={() => win.location.reload()} /></ThemeProvider>;
}
export function mountWebApp(win: WebWindow) {
 configureZodForCsp();
 const root = win.document.getElementById("root");if (!root) throw new Error("App root missing");
 const nonce = win.document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
 if (!nonce) throw new Error("App nonce missing");setNonce(nonce);
 createRoot(root).render(<WebRoot win={win} />);
}
