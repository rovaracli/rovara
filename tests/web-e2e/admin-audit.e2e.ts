import { test, expect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
import { AUDIT_LIMITS_COPY } from "../../packages/ui/src/screens/admin/audit/metadata.js";
const status = { headSeq: 3, sealedThroughSeq: 2, latestTimestamp: "2026-10-01T00:00:00Z", epochsWithoutTimestamp: ["epoch"], lockMode: "GOVERNANCE" };
test.beforeEach(async ({ context, request, baseURL, page }) => {
 await request.post("/__mock/scenario", { data: { name: "admin" } });await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.route("**/v1/web/org/audit/status", route => route.fulfill({ json: { ...status, limits: AUDIT_LIMITS_COPY } }));
 await page.route("**/v1/web/org/audit/records?*", route => { const query=new URL(route.request().url()).searchParams, next=query.has("cursor");return route.fulfill({json:{...status,records:[{record:{orgId:"org_aaaaaaaaaaaaaaaaaaaa",seq:next?2:1,action:next?"org.renamed":"member.role_changed",recordedAt:"2026-10-01T00:00:01Z",occurredAt:"2026-10-01T00:00:00Z",actor:{kind:"member",id:"actor-pseudonym"},target:{kind:"member",id:"target-pseudonym"},proof:{kind:"browser"}},details:[{fields:{email:"synthetic@example.test"},salt:"unneeded-salt"}]}],...(next?{}:{nextCursor:"next_page"})}}); });
});
for (const theme of ["light","dark"] as const) test(`audit metadata, caveats and bounded paging in ${theme}`,async({page})=>{
 const reads:string[]=[];const mutations:string[]=[];page.on("request",r=>{if(r.url().includes("/v1/web/org/audit/")){reads.push(r.url());if(r.method()!=="GET")mutations.push(r.method());}});
 await page.goto("/app/admin/audit");await expect(page.getByRole("heading",{name:"Audit",exact:true})).toBeVisible();await expect(page.getByText("member.role_changed",{exact:true})).toBeVisible();await expect(page.getByText("1 unsealed record",{exact:true})).toBeVisible();await expect(page.getByText("synthetic@example.test")).toHaveCount(0);await checkA11y(page,{theme});expect(reads).toHaveLength(2);
 await page.getByRole("button",{name:"Next page",exact:true}).click();await expect(page.getByText("org.renamed",{exact:true})).toBeVisible();expect(reads.filter(url=>url.includes("/records?"))).toHaveLength(2);
 await page.getByLabel("From (UTC)").fill("2026-10-01T00:00");await page.getByLabel("Through (UTC)").fill("2026-10-02T00:00");await page.getByRole("button",{name:"Apply time range",exact:true}).click();await expect(page.getByText("member.role_changed",{exact:true})).toBeVisible();expect(new URL(reads.filter(url=>url.includes("/records?")).at(-1)!).searchParams.has("cursor")).toBe(false);
 expect(mutations).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await checkA11y(page,{theme});if(theme==="light")await page.screenshot({path:".superpowers/sdd/codex/c2-audit.png",fullPage:true});
});
