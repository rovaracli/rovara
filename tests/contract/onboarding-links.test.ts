import { expect,it } from "vitest";
import { githubConnectPage } from "../../packages/broker/src/org/github-connect-page.js";
for(const [kind,status] of [["connected","connected"],["connected_trial_used","trial_used"],["requested","requested"]] as const)it("returns from GitHub to onboarding: "+kind,()=>{const page=githubConnectPage(kind);expect(page.body).toContain('href="/app/onboard?github='+status+'"');expect(page.body).toContain('>Continue in Rovara</a>');});
