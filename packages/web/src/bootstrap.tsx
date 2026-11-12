import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { setNonce } from "get-nonce";
import { configureZodForCsp } from "@agentx/cloud-contracts/web";
import { App, type AppRouterFactory } from "@agentx/ui";
import { createBrowserHost } from "./browser-host.js";
type WebWindow = Window & Pick<typeof globalThis, "URL" | "WebSocket">;
const createRouter: AppRouterFactory = routes => createBrowserRouter(routes);
/**
 * Decision 125 follow-up: a chunk that cannot load (vite:preloadError, the import's rejection) is no longer turned into a page of its own that replaces the app. The import rejects where it was asked for, and the
 * route's guard (routes.tsx, guardLazy), the screen's error element or a part's boundary shows "Rovara was updated. Reload to continue." in its place, inside the shell; App's own boundary catches the rest.
 */
function WebRoot({ win }: { win: WebWindow }) {
 const [host] = useState(() => createBrowserHost(win));
 return <App host={host} createRouter={createRouter} />;
}
export function mountWebApp(win: WebWindow) {
 configureZodForCsp();
 const root = win.document.getElementById("root");if (!root) throw new Error("App root missing");
 const nonce = win.document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
 if (!nonce) throw new Error("App nonce missing");setNonce(nonce);
 createRoot(root).render(<WebRoot win={win} />);
}
