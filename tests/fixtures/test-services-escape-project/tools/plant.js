"use strict";
// Run in the WORKING phase (the task asks the agent to run `npm run plant`): plants state in the working-phase Postgres, the way an agent's own commands could: a table in the public schema, a table in another schema, and (when the
// role may) a server setting written with ALTER SYSTEM. It then reads it back, so a plant that did not happen fails here, and it leaves a receipt in the workspace. The sealed round starts a brand-new Postgres, so
// tests/planted-state.test.js asserts that none of it is there, and that the receipt exists (a round that never saw a working phase cannot pass).
const fs = require("node:fs");
const { query } = require("../lib/pg.js");
const { plantFile } = require("../lib/state.js");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("no DATABASE_URL: this must run in the working sandbox, where the run's variables are set");
  await query(url, "create table if not exists planted_escape (id int primary key)");
  await query(url, "create schema if not exists escape_planted");
  await query(url, "create table if not exists escape_planted.planted_escape_other (id int primary key)");
  let marker = false;
  try {
    await query(url, "alter system set escape.marker = 'planted'");
    await query(url, "select pg_reload_conf()");
    marker = true;
  } catch { /* the role may not be a superuser: the two tables are the plant */ }
  const rows = await query(url, "select table_schema || '.' || table_name from information_schema.tables where table_name like 'planted_escape%' order by 1");
  const objects = rows.map((row) => row[0]);
  if (objects.length !== 2) throw new Error(`the plant did not take: found ${JSON.stringify(objects)}`);
  fs.writeFileSync(plantFile(), JSON.stringify({ at: Date.now(), objects, marker }) + "\n");
  console.log(`OK planted ${objects.join(", ")}${marker ? " and a server setting" : ""}`);
}
main().then(() => process.exit(0), (error) => { console.error(String(error && error.message)); process.exit(1); });
