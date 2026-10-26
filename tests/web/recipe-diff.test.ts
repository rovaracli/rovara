// @vitest-environment jsdom
import {expect,it} from "vitest";
import {screen,within} from "@testing-library/react";
import {QueryClientProvider} from "@tanstack/react-query";
import {RecipeDiffView} from "../../packages/ui/src/screens/builder/RecipeDiffView.js";
import {PublishDialog} from "../../packages/ui/src/screens/builder/PublishDialog.js";
import {AppHostProvider} from "../../packages/ui/src/host.js";
import {createQueryClient} from "../../packages/ui/src/api/query.js";
import {builderFixture} from "./support/builder-fixture.js";
import {agentProfile,AGENT_FIXTURE_ID} from "./support/agent-fixture.js";
import {fakeHost} from "./support/fake-host.js";
import {renderUi} from "./support/render.js";
import {h} from "./support/h.js";
import {expectNoAxeViolations} from "./support/axe.js";
import {fireEvent} from "@testing-library/react";
function mount(body:unknown,publish=false){const f=fakeHost(async()=>({status:200,body})),query=createQueryClient(),ui=renderUi(h(AppHostProvider,{host:f.host,children:h(QueryClientProvider,{client:query,children:publish?h(PublishDialog,{agent:agentProfile().agent,revision:2,disabled:false,onPublished:()=>undefined,onInvalid:()=>undefined}):h("main",{},h("h1",{},"Review the method"),h(RecipeDiffView,{id:AGENT_FIXTURE_ID,from:3,to:"draft"}))})}));return{...f,...ui,close(){ui.unmount();query.clear();}};}
function comparison(){const before=structuredClone(builderFixture().base!),after=structuredClone(before);before.steps[0]!.settings.instructions=[{agentName:"Payments Expert",text:"Check refund idempotency."}];after.steps[0]!.settings.instructions=[{agentName:"Payments Expert",text:"Check duplicate webhooks.\n<img src=x onerror=window.__pwned=1>"}];return{before,after};}
it("groups instruction changes into an attributed before-and-after comparison without raw paths",async()=>{const f=mount({from:3,to:"draft",changes:["/steps/0/settings/instructions/0/text","/steps/0/settings/instructions/0/agentName"],lessSafe:[],comparison:comparison()});await screen.findByRole("heading",{name:"Plan · Additional instructions"});expect(screen.getAllByRole("heading",{name:"Plan · Additional instructions"})).toHaveLength(1);expect(screen.getByText("Before · Version 3")).toBeTruthy();expect(screen.getByText("After · Draft")).toBeTruthy();expect(screen.getByText("Check refund idempotency.")).toBeTruthy();expect(screen.getByText(/Check duplicate webhooks/)).toBeTruthy();expect(f.container.textContent).not.toContain("/steps/");expect(f.container.querySelector("img,script")).toBeNull();await expectNoAxeViolations(f.container);f.close();});
it("keeps added and removed steps explicit",async()=>{const c=comparison();c.after.steps.splice(0,1);const f=mount({from:3,to:"draft",changes:["/steps"],lessSafe:[],comparison:c});await screen.findByText("Removed step: Plan");expect(screen.getByText("Before · Version 3")).toBeTruthy();expect(screen.getByText("After · Draft")).toBeTruthy();f.close();});
it("does not enable publication when only raw pointers are available",async()=>{const f=mount({from:3,to:"draft",changes:["/steps/0/settings/model"],lessSafe:[]},true);fireEvent.click(screen.getByRole("button",{name:"Publish"}));await screen.findByText("The before-and-after comparison is unavailable. Refresh before publishing.");expect(screen.getByRole("button",{name:"Publish this draft"})).toHaveProperty("disabled",true);f.close();});
it("retains human-readable descriptions from older cells",async()=>{const f=mount({from:3,to:"draft",changes:["Review now uses the company model."],lessSafe:[]});await screen.findByText("Review now uses the company model.");f.close();});
it("never follows a prototype property as a recipe field",async()=>{const f=mount({from:3,to:"draft",changes:["/__proto__/constructor"],lessSafe:[],comparison:comparison()});await screen.findByText("The before-and-after comparison is unavailable. Refresh before publishing.");expect(f.container.textContent).not.toContain("function Object");f.close();});
