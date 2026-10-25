// @vitest-environment jsdom
import { expect,it } from "vitest";
import { fireEvent,screen,waitFor } from "@testing-library/react";
import { renderBuilder } from "./support/builder-render.js";
import { builderFixture } from "./support/builder-fixture.js";
import { expectNoAxeViolations } from "./support/axe.js";
it("removing an edited step removes its obsolete overlay patch before saving",async()=>{
 const f=renderBuilder({draft:{...builderFixture(),draft:{...builderFixture().draft,overlay:{steps:{review:{instructions:"Check payments"}}}}}});await screen.findByRole("heading",{name:"Payments Expert"});fireEvent.click(await screen.findByRole("button",{name:"Remove Review",exact:true}));await waitFor(()=>expect(f.request.mock.calls.some(([request])=>request.method==="PUT")).toBe(true),{timeout:2000});const write=f.request.mock.calls.find(([request])=>request.method==="PUT")![0];expect(write.body).not.toMatchObject({overlay:{steps:{review:expect.anything()}}});f.close();
});
it("retains local conflict text while showing the actual server draft",async()=>{
 const f=renderBuilder({reply:async()=>({status:409,body:{error:{code:"AGENT_REVISION_CONFLICT",message:"This draft changed. Reload it and try again."}}})});await screen.findByLabelText("Additional instructions");fireEvent.change(screen.getByLabelText("Additional instructions"),{target:{value:"Keep my judgment"}});await screen.findByText("This draft changed. Reload it and try again.",{}, {timeout:2000});expect((screen.getByLabelText("Additional instructions") as HTMLTextAreaElement).value).toBe("Keep my judgment");fireEvent.click(screen.getByRole("button",{name:"Show server draft"}));await screen.findByText("{}",{exact:true});expect((screen.getByLabelText("Additional instructions") as HTMLTextAreaElement).value).toBe("Keep my judgment");f.close();
});
it("shows only the nonidentifying provenance label when the origin is hidden",async()=>{const draft=builderFixture();draft.draft.origin={kind:"session",visible:false};const f=renderBuilder({draft});await screen.findByText("Made from a session",{exact:true});expect(screen.queryByRole("link",{name:/session/i})).toBeNull();f.close();});
for(const theme of ["light","dark"] as const)it("has accessible builder structure in "+theme,async()=>{const f=renderBuilder({theme});await screen.findByLabelText("Additional instructions");await expectNoAxeViolations(f.container);f.close();});
