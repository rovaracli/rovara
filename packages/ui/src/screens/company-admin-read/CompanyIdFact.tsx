import { useState } from "react";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { Fact } from "./parts.js";

/** The company's id (`org.orgId` of `GET /v1/app/me`, the id the admin area already holds) with a Copy button, for the places that ask for it (a support request, a connection set-up). Nothing else is said about it. */
export function CompanyIdFact({ orgId }: { orgId: string }) {
 const host = useAppHost();
 const [state, setState] = useState<"copied" | "failed">();
 async function copy() {
  try { await (host.copyText !== undefined ? host.copyText(orgId) : navigator.clipboard.writeText(orgId)); setState("copied"); } catch { setState("failed"); }
 }
 if (orgId === "") return null;
 return <Fact label="Company ID"><code data-testid="company-id"><VisibleText text={orgId} /></code> <Button onClick={() => { void copy(); }} aria-label="Copy the company ID">Copy</Button>{state === "copied" && <span role="status"> Copied.</span>}{state === "failed" && <span role="alert"> Couldn't copy. Select the ID and copy it by hand.</span>}</Fact>;
}
