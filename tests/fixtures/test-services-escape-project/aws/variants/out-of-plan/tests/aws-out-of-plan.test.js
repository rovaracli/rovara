"use strict";
// The out-of-plan variant (copy it over the project only for the "flag project"; see the README): the code calls an AWS service the plan did not ask for (SNS) AT THE EMULATOR. The emulator must refuse (any 4xx or 5xx; never 2xx),
// and the call is then in its ledger, so Rovara's evidence flags "The code called AWS services that are not in the plan". This test passes when the call is refused; the done-check reads the flag from the task's evidence.
const test = require("node:test");
const assert = require("node:assert/strict");
const { endpoint, call } = require("../lib/aws-http.js");

test("an SNS call to the emulator is refused", async () => {
  const url = endpoint();
  assert.ok(url, "the run gave this check no AWS_ENDPOINT_URL_S3: there is no emulator to test");
  const answer = await call(url, { method: "POST", path: "/", service: "sns", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "Action=Publish&TopicArn=arn%3Aaws%3Asns%3Aus-east-1%3A000000000000%3Aalerts&Message=x&Version=2010-03-31" });
  assert.ok(answer.status !== undefined, `nothing answered the SNS call (${answer.error}): it never reached the emulator, so it cannot be in the ledger`);
  assert.ok(answer.status >= 400, `the emulator accepted an SNS call that is not in the plan (${answer.status})`);
});
