// The sidebar's "Agent directory" link opens /app/agents, which reads `/v1/app/agents`: a route neither Cloud nor Rovara Code serves yet (Cloud answers 501 NOT_ON_CODE_YET).
// Until it does the link is not shown. Turn this on in the same change that adds the route. The screen and its address stay; `Sidebar` takes `agentDirectoryOffered` so a test can show the link.
export const AGENT_DIRECTORY_OFFERED = false;
