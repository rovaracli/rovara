// @vitest-environment jsdom
import { AgentDraftPutBodySchema } from "@agentx/cloud-contracts/web";
import { expect,it } from "vitest";
import { fireEvent,screen,waitFor } from "@testing-library/react";
import { renderBuilder } from "./support/builder-render.js";
import { agentProfile } from "./support/agent-fixture.js";
import { builderFixture } from "./support/builder-fixture.js";
import { expectNoAxeViolations } from "./support/axe.js";
it("removing an edited step removes its obsolete overlay patch before saving",async()=>{
 const f=renderBuilder({draft:{...builderFixture(),draft:{...builderFixture().draft,overlay:{steps:{review:{instructions:"Check payments"}}}}}});await screen.findByRole("heading",{name:"Payments Expert"});fireEvent.click(await screen.findByRole("button",{name:"Remove Review"}));await waitFor(()=>expect(f.request.mock.calls.some(([request])=>request.method==="PUT")).toBe(true),{timeout:2000});const write=f.request.mock.calls.find(([request])=>request.method==="PUT")![0];expect(AgentDraftPutBodySchema.parse(write.body).overlay.steps?.review).toBeUndefined();f.close();
});
it("retains local conflict text while showing the actual server draft",async()=>{
 const f=renderBuilder({reply:async()=>({status:409,body:{error:{code:"AGENT_REVISION_CONFLICT",message:"Someone else changed this agent's draft. Reload it and make your change again."}}})});await screen.findByLabelText("Additional instructions");fireEvent.change(screen.getByLabelText("Additional instructions"),{target:{value:"Keep my judgment"}});await screen.findByText("Someone else changed this agent's draft. Reload it and make your change again.",{}, {timeout:2000});expect(screen.getByLabelText("Additional instructions")).toHaveProperty("value","Keep my judgment");fireEvent.click(screen.getByRole("button",{name:"Show server draft"}));await screen.findByText("{}",{exact:true});expect(screen.getByLabelText("Additional instructions")).toHaveProperty("value","Keep my judgment");f.close();
});
it("shows only the nonidentifying provenance label when the origin is hidden",async()=>{const draft=builderFixture();draft.draft.origin={kind:"session",visible:false};const f=renderBuilder({draft});await screen.findByText("Made from a session",{exact:true});expect(screen.queryByRole("link",{name:/session/i})).toBeNull();f.close();});
for(const theme of ["light","dark"] as const)it("has accessible builder structure in "+theme,async()=>{const f=renderBuilder({theme});await screen.findByLabelText("Additional instructions");await expectNoAxeViolations(f.container);f.close();});

it("does not request a draft for a view-only profile",async()=>{const profile=agentProfile();profile.agent.access="view";const f=renderBuilder({profile});const heading=await screen.findByRole("heading",{name:"Payments Expert"});expect(document.activeElement).toBe(heading);expect(f.request.mock.calls.some(([request])=>request.path.endsWith("/draft"))).toBe(false);f.close();});
it("lets a view-only teammate inspect published versions without reading or editing a draft",async()=>{const profile=agentProfile();profile.agent.access="view";const f=renderBuilder({profile,path:"/app/agents/agt_aaaaaaaaaaaaaaaaaaaa/edit?from=3&to=2"});await screen.findByText("Review now uses claude-sonnet-4-6 instead of gpt-5.4");expect(screen.queryByRole("option",{name:"Draft"})).toBeNull();expect(screen.queryByRole("button",{name:"Publish"})).toBeNull();expect(screen.queryByRole("button",{name:"Test draft"})).toBeNull();expect(f.request.mock.calls.some(([request])=>request.path.endsWith("/draft"))).toBe(false);f.close();});
