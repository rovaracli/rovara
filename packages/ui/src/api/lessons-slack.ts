// The person's own "Don't learn from my Slack messages" switch (L4-SRC-SL). Cloud passes both calls to Rovara Code as the signed-in person (cloud-server/src/lessons-slack-switch.ts); the answer is `{ optOut }` and nothing else.
//   GET /v1/app/me/lessons-slack                -> { optOut: boolean }
//   PUT /v1/app/me/lessons-slack  { optOut }    -> { optOut: boolean }
// Until the Code in use serves the route, Cloud answers 501 and the account page hides the switch.
export const LESSONS_SLACK_PATH = "/v1/app/me/lessons-slack";
export interface LessonsSlackSwitch { optOut: boolean }
export function readLessonsSlackSwitch(body: unknown): LessonsSlackSwitch {
  if (typeof body !== "object" || body === null || Array.isArray(body) || typeof (body as { optOut?: unknown }).optOut !== "boolean") throw new Error("not the Slack learning switch");
  return { optOut: (body as { optOut: boolean }).optOut };
}
