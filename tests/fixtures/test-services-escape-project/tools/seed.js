"use strict";
// The dependency's seed: creates the one table the run's database should hold.
const { query } = require("../lib/pg.js");

query(process.env.DATABASE_URL, "create table if not exists seeded_in_round (id int primary key)").then(
  () => process.exit(0),
  (error) => { console.error(String(error && error.message)); process.exit(1); },
);
