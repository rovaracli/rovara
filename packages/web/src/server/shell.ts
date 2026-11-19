import { assetOrigin } from "./headers.js";
export function renderShell(index: string, origin: string, nonce: string): string {
 if (!/^[A-Za-z0-9_-]+$/.test(nonce)) throw new Error("Invalid response nonce.");
 const main = /<script\b[^>]*\bsrc=["']\.\/assets\/([A-Za-z0-9._-]+\.js)["'][^>]*\btype=["']module["'][^>]*>/i.exec(index)?.[1]
  ?? /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']\.\/assets\/([A-Za-z0-9._-]+\.js)["'][^>]*>/i.exec(index)?.[1];
 return index.replaceAll("./assets/", `${assetOrigin(origin)}/app/assets/`).replace(/<head(?:\s[^>]*)?>/i, head => `${head}<meta name="csp-nonce" content="${nonce}">${main === undefined ? "" : `<meta name="rovara-cloud-app" content="${main}">`}`);
}
