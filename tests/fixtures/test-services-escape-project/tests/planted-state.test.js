"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { query } = require("../lib/pg.js");

// A sealed round starts brand-new helpers and seeds them from the candidate code. So the run's database holds the seeded table and nothing else: nothing a working phase (the agent's own commands) planted, and nothing left
// by an earlier round.
test("the run's database holds exactly the seeded table", async () => {
  const url = process.env.DATABASE_URL;
  assert.ok(url, "the run gave this check no DATABASE_URL");
  const rows = await query(url, "select table_name from information_schema.tables where table_schema = 'public' order by table_name");
  assert.deepEqual(rows.map((row) => row[0]), ["seeded_in_round"]);
});
