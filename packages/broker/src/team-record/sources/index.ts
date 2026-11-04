// Team record ingest sources (lane "ingest": R5 GitHub and Rovara, R6 Slack, R7 tickets and MCP pollers).
export * from "./ports.js";
export { cleanText, permalink, TEXT_MAX_BYTES } from "./common.js";
export * from "./codehost.js";
export { createGithubRecordTap, createGithubDiffReader, githubEventsOf, type GithubGetJson, type GithubRecordTapDependencies } from "./github.js";
export * from "./rovara.js";
export * from "./slack.js";
export * from "./tickets.js";
export * from "./parent-lookup.js";
export * from "./ticket-webhooks.js";
export * from "./mcp-poller.js";
export * from "./existence-sweep.js";
export * from "./queue.js";
