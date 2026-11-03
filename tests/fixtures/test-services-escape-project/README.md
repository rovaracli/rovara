# Test services escape project

A project for the staging done-check of Rovara test services (slice 1). Its **tests try to escape** the sealed check round and assert that every attempt fails, so a passing run is the proof, and it comes back through the task's normal evidence (no shell on the worker is needed).

Settings of the staging project that uses it:

- setup: `npm run setup` (starts a detached heartbeat in the WORKING sandbox, for the pause check)
- readiness / checks: `npm test` (kind: test)
- one dependency: Postgres 16 (`DATABASE_URL`), seeded by `npm run seed` (creates one table, `seeded_in_round`)

| test file | what it tries | passes when |
|---|---|---|
| `internet.test.js` | TCP to public IPv4 addresses; a public name must not resolve to a public address | every connection fails; the name does not resolve publicly |
| `ipv6.test.js` | TCP to a public IPv6 address; the interfaces | the connection fails; no global IPv6 address is configured |
| `neighbours.test.js` | the working sandbox's address (.3), the gateway (.1), the metadata address | every connection fails; and the run's own Postgres IS reachable (the positive control: the network is not just dead) |
| `planted-state.test.js` | asks the run's Postgres which tables exist | exactly the seeded table is there: nothing planted by a working phase |
| `relay.test.js` | reads the heartbeat file a detached process in the working sandbox updates, twice | the file does not change while the round runs (the working sandbox is frozen) |

Each target can be replaced with an environment variable (see `lib/targets.js`) so the repository's own tests can aim a test at something reachable and check that it then FAILS (tests/contract/test-services-escape-project.test.ts). Not covered here, because they need privileges the check sandbox does not have: spoofed source addresses (TS-SEAL-4) and raw multicast; those stay Linux checks of scripts/linux-check-test-services.sh.
