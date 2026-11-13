import { defineScenario } from "../harness/types.js";

// Features-C lane: a task started from an AI tool (Cloud: its MCP server's agentx_start_workflow; core: the request Code's MCP tool sends to the task
// route), then planned. The MCP start replaces `start`.
export default defineScenario({
  id: "mcp-tools",
  title: "An AI tool starts a Quick task through MCP and it plans",
  areas: [34],
  kind: "happy",
  steps: [
    { do: "feature", name: "mcp-tools" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
  ],
});
