// @vitest-environment jsdom
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSettingsPanel } from "../../packages/ui/src/screens/builder/AgentSettingsPanel.js";
import { ProblemsList } from "../../packages/ui/src/screens/builder/ProblemsList.js";
import { StepSettingsPanel } from "../../packages/ui/src/screens/builder/StepSettingsPanel.js";
it("disables autonomy beyond the actual company maximum",()=>{
 const change=vi.fn();render(h(AgentSettingsPanel,{overlay:{},maxAutonomy:"prepare",skills:[],onChange:change}));expect((screen.getByRole("option",{name:"Run"}) as HTMLOptionElement).disabled).toBe(true);expect(screen.getByText("Your company allows up to Prepare")).toBeTruthy();fireEvent.change(screen.getByLabelText("Autonomy"),{target:{value:"suggest"}});expect(change).toHaveBeenCalledWith(expect.objectContaining({autonomy:"suggest"}));
});
it("turns problem paths into words and focuses the exact field",()=>{
 const field=document.createElement("input");field.id="builder-steps-2-settings-model";document.body.append(field);render(h(ProblemsList,{problems:[{path:"steps.2.settings.model",message:"Choose an allowed model"}],onFocus:vi.fn()}));fireEvent.click(screen.getByRole("button",{name:"Step 3, model: Choose an allowed model"}));expect(document.activeElement).toBe(field);field.remove();
});
it("cannot enter a sixth review round and lists only the supplied models",()=>{
 const change=vi.fn();render(h(StepSettingsPanel,{step:{id:"review",name:"Review",kind:"review",reviewers:["code"],onFindings:{backTo:"build",maxRounds:3}},index:2,sequence:[{id:"build",name:"Build",kind:"build"},{id:"review",name:"Review",kind:"review",reviewers:["code"]}],settings:{},models:[{provider:"openai",modelId:"allowed",label:"Allowed",company:"openai",sources:["rovara"]}],onChange:change,onStepChange:vi.fn()}));
 expect((screen.getByLabelText("At most rounds") as HTMLInputElement).max).toBe("5");fireEvent.change(screen.getByLabelText("At most rounds"),{target:{value:"6"}});expect(change).not.toHaveBeenCalled();fireEvent.click(screen.getByText("Models and limits"));expect(screen.getAllByRole("option",{name:"Allowed"})).toHaveLength(2);expect(screen.queryByRole("option",{name:"Unlisted"})).toBeNull();
});

afterEach(cleanup);
it("shows inherited autonomy and tool grants before an override exists",()=>{const change=vi.fn();render(h(AgentSettingsPanel,{overlay:{},maxAutonomy:"run",skills:[],inherited:{autonomy:"run",allowMentions:true,tools:[{connector:{type:"github"},access:"read"}]},onChange:change}));expect((screen.getByLabelText("Autonomy") as HTMLSelectElement).value).toBe("run");fireEvent.click(screen.getByText("Tool grants and approval rules"));expect(screen.getByText("github",{selector:"p"})).toBeTruthy();expect(screen.getByRole("checkbox",{name:"Allow @-mentions in comments"}).getAttribute("aria-checked")).toBe("true");});
