# Script tokens

A script token lets your own scripts and CI jobs read and start your Rovara tasks without a browser sign-in.
It is off until an operator turns it on (`agentx config set scriptTokens.enabled 1`, see [day-two.md](day-two.md)).

## Make one

1. In the Rovara app, open **Script tokens** in the side menu.
2. Give it a name (what uses it), pick the projects, and pick what it may do:
   - **Read tasks**: read your own tasks on those projects (one task, its events, the list for one project).
   - **Start tasks**: start a task on one of those projects.
3. Pick how long it lasts: 30 days unless you choose, 90 days at most.
4. Press **Make token** and copy it. Rovara shows it once and keeps only a hash of it. If you lose it, revoke it
   and make another.

A token starts with `rvst_`. Keep it in your CI's secret store, never in code or logs.

## What a token can and can't do

- It acts as you: never with more access than you have, and only on the projects and permissions you chose.
- It stops working when it expires, when you (or a company owner or admin) revoke it, when your company role
  changes, when you leave the company, or when an admin ends your sign-ins. Make a new one after any of these.
- It can never make tokens, change members, roles, billing, company settings or secrets, or approve or decide
  anything that needs a person. Those need the app.
- A token makes at most 60 requests a minute and starts at most 20 tasks an hour. You can have 10 live tokens.
- Rovara's audit log records when a token is made, its first use each day, and when it is revoked.

## Use it

Send it as a bearer token. `ROVARA_URL` is the address you open Rovara at.

```sh
# Start a task. requestId makes a retry safe: the same id returns the same task.
curl -sS -X POST "$ROVARA_URL/v1/dev/tasks" \
  -H "Authorization: Bearer $ROVARA_TOKEN" -H "content-type: application/json" \
  -d '{"requestId":"'"$(uuidgen | tr 'A-Z' 'a-z')"'","project":"payments","instructions":"Fix the flaky retry test","client":"ci"}'

# Read a task's status (the taskId from the start's answer).
curl -sS "$ROVARA_URL/v1/dev/tasks/$TASK_ID" -H "Authorization: Bearer $ROVARA_TOKEN"

# The task's events, and your tasks on one project.
curl -sS "$ROVARA_URL/v1/dev/tasks/$TASK_ID/events" -H "Authorization: Bearer $ROVARA_TOKEN"
curl -sS "$ROVARA_URL/v1/dev/tasks?project=payments" -H "Authorization: Bearer $ROVARA_TOKEN"
```

Answers: `401` the token isn't valid, expired, was revoked or stopped (the message says which); `403` the token
may not do that; `404` no such task on the token's projects; `429` too many requests, try again later.
