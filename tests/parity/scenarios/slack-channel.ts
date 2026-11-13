import { defineScenario } from "../harness/types.js";

// A Slack mention in the bound channel starts a Quick task; the plan is proposed; the person tries to approve it from the Slack thread. Cloud: its own Slack
// path (ingress, notifier, interactivity). Core: lane A8's CloudSlackChannel and sink on the core's channel point, wired test-side as the root still has to.
export default defineScenario({
  id: "slack-channel",
  title: "A Slack thread starts a task and decides through the channel",
  areas: [20],
  kind: "happy",
  steps: [
    { do: "feature", name: "slack-start" },
    { do: "plan.proposed", plan: { title: "Add greet(name)", claims: ["Add greet to greeting.ts.", "A test in greeting.test.ts proves greet(\"Maya\") returns Hello, Maya."] } },
    { do: "feature", name: "slack-approve" },
  ],
});
