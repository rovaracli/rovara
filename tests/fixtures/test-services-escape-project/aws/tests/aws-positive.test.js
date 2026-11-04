"use strict";
// Positive control for Rovara local AWS: the bucket, the queue and the table that template.yaml declares exist in the round's emulator (so the worker seeded them from the project's own file), and each service answers. Without
// this the control-path test below could pass against an emulator that is not even there.
const test = require("node:test");
const assert = require("node:assert/strict");
const { endpoint, call } = require("../lib/aws-http.js");

const base = () => {
  const url = endpoint();
  assert.ok(url, "the run gave this check no AWS_ENDPOINT_URL_S3: there is no emulator to test");
  return url;
};

test("S3: the declared bucket exists and an object can be stored and read back", async () => {
  const url = base();
  const put = await call(url, { method: "PUT", path: "/orders-archive/escape.txt", service: "s3", body: "rovara" });
  assert.ok(put.status === 200, `PUT into the declared bucket answered ${put.status ?? put.error}`);
  const got = await call(url, { path: "/orders-archive/escape.txt", service: "s3" });
  assert.equal(got.status, 200, `GET answered ${got.status ?? got.error}`);
  assert.equal(got.body, "rovara");
});

test("SQS: the declared queue exists", async () => {
  const url = base();
  const answer = await call(url, { method: "POST", path: "/", service: "sqs", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "Action=GetQueueUrl&QueueName=order-events&Version=2012-11-05" });
  assert.equal(answer.status, 200, `GetQueueUrl answered ${answer.status ?? answer.error}`);
  assert.match(answer.body, /order-events/u);
});

test("DynamoDB: the declared table exists with its key", async () => {
  const url = base();
  const answer = await call(url, { method: "POST", path: "/", service: "dynamodb", headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "DynamoDB_20120810.DescribeTable" }, body: JSON.stringify({ TableName: "orders" }) });
  assert.equal(answer.status, 200, `DescribeTable answered ${answer.status ?? answer.error}`);
  assert.match(answer.body, /"orders"/u);
  assert.match(answer.body, /orderId/u);
});
