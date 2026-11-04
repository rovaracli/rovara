"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { query } = require("../lib/pg.js");
const { plantFile, readJson } = require("../lib/state.js");

// The task asks the agent to run `npm run plant` in the WORKING phase (tools/plant.js): that plants a table in the public schema, a table in another schema and, when the role may, a server setting, in the working-phase
// Postgres, and leaves a receipt in the workspace. A sealed round starts brand-new helpers and seeds them from the candidate code, so the run's database must hold the seeded table and NOTHING the working phase planted, in any schema.
test("the working phase really planted something (the receipt), so the next test is not vacuous", () => {
  const receipt = readJson(plantFile());
  assert.ok(receipt, "no plant receipt: the working phase never ran `npm run plant`, so there is nothing to prove absent");
  assert.ok(Array.isArray(receipt.objects) && receipt.objects.length === 2, "the receipt lists no planted objects");
});

test("the run's database holds exactly the seeded table, in every schema, and no planted setting", async () => {
  const url = process.env.DATABASE_URL;
  assert.ok(url, "the run gave this check no DATABASE_URL");
  const tables = await query(url, "select table_schema || '.' || table_name from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema') order by 1");
  assert.deepEqual(tables.map((row) => row[0]), ["public.seeded_in_round"]);
  const schemas = await query(url, "select schema_name from information_schema.schemata where schema_name like 'escape%' order by 1");
  assert.deepEqual(schemas.map((row) => row[0]), []);
  const marker = await query(url, "select current_setting('escape.marker', true)");
  assert.deepEqual(marker, [[null]], "the planted server setting is there");
});
