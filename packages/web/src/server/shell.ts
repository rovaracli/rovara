import { assetOrigin } from "./headers.js";
export function renderShell(index: string, origin: string, nonce: string): string {
 if (!/^[A-Za-z0-9_-]+$/.test(nonce)) throw new Error("Invalid response nonce.");
 return index.replaceAll("./assets/", `${assetOrigin(origin)}/app/assets/`).replace(/<head(?:\s[^>]*)?>/i, head => `${head}<meta name="csp-nonce" content="${nonce}">`);
}
