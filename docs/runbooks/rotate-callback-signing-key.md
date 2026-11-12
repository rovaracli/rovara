# Rotate the callback signing key

The callback signing key signs short-lived tokens: worker callbacks, repository grants, cancel, project setup and eval
tokens. Since 0.5.15 a named environment's functions read it from Secrets Manager
(`packages/broker/src/aws/signing-key-secrets.ts`), not from a Lambda variable. This runbook replaces it on staging.

**Owner go required.** Don't run any write step below without the owner's go for this rotation. Show the owner the
preview first (step 1). Run every AWS command through `~/.local/share/rovara-tools/staging-aws.sh` (us-west-2,
account 944937319445). Never print, log or paste a key value. Never call `get-secret-value` or
`batch-get-secret-value` by hand.

## What a rotation changes, and what it never changes

| Secret | Kind | Rotated here? |
|---|---|---|
| `agentx/staging/callback-signing-key` | Signs tokens. They expire in hours at most. | Yes |
| `agentx/staging/erasure-hash-key` | Hashes stored values: erased people's names and aliases, and Ask question hashes. | **Never** |

Don't touch the erasure hash key. Every stored hash is keyed with it, so a new value would leave those hashes
unmatched: an erased person's name would no longer be scrubbed from Ask answers. Rotating it needs its own plan
first: re-hash every stored alias and question hash under the new key, in one migration, then switch the key. No
such plan exists today.

How the overlap works:

- Readers always issue tokens with the secret's `AWSCURRENT` version.
- When they verify a token, readers also accept the `AWSPREVIOUS` version, but only for **24 hours after the current
  version was created** (`PREVIOUS_KEY_WINDOW_MS`). After that the previous key verifies nothing, even if the label
  is still there. So in-flight callbacks keep working across a rotation, and the old key stops working on its own.
- `put-secret-value` moves the labels itself: the new value becomes `AWSCURRENT` and the old one becomes
  `AWSPREVIOUS`.
- Each function reads the key once per execution environment (cold start) and keeps it in memory. A rotation reaches
  a function only after you roll it (step 3). Until then a warm execution environment still holds the **old** key as
  its current key, with no window at all: it keeps accepting tokens signed with the old key for as long as it lives,
  and it refuses tokens signed with the new key. **Step 3 is therefore mandatory, and you run it right after step 2.**
  Without it the old key is not revoked.

Functions that read the callback signing key: the broker, the eval batch tick, and the session reconciler. Only the
broker reads the erasure hash key.

## Failure behaviour (for the release notes)

If the broker can't read either secret, it refuses every request, worker callbacks included, until a read succeeds.
A failed read isn't cached, so the next request tries again.

## The 0.5.15 upgrade itself (once per environment)

The upgrade creates `erasure-hash-key` from the callback key's current value. It does this only while the callback key
has never been replaced (one version, no `AWSPREVIOUS`). If the callback key was replaced, the upgrade refuses: it says
to restore the erasure key or run a re-hash, and it creates nothing. It refuses the same way when both keys are gone
from an environment that already exists. Before the upgrade, check
`describe-secret --secret-id agentx/staging/callback-signing-key --query VersionIdsToStages`. If it lists more than one
version, the owner decides how to create the erasure key before you upgrade: its value must be the one the stored
hashes were made with.

## 1. Preview (read-only; show this to the owner)

```sh
S=~/.local/share/rovara-tools/staging-aws.sh
# a. Staging runs 0.5.15 or later: the broker has no CALLBACK_SIGNING_KEY variable (variable names only, no values).
$S aws lambda list-functions --query "Functions[?starts_with(FunctionName, 'agentx-staging-control-plane-Broker')].FunctionName" --output text
$S aws lambda get-function-configuration --function-name <broker function> --query 'keys(Environment.Variables)' --output json
#    STOP if CALLBACK_SIGNING_KEY is in the list: the release still reads the variable, and this runbook does not apply.

# b. Both secrets exist. This shows their versions and labels, never a value.
$S aws secretsmanager describe-secret --secret-id agentx/staging/callback-signing-key --query '{Versions: VersionIdsToStages, Changed: LastChangedDate}'
$S aws secretsmanager describe-secret --secret-id agentx/staging/erasure-hash-key --query '{Versions: VersionIdsToStages, Created: CreatedDate}'
#    STOP if the erasure hash key does not exist: the broker refuses to start without it. Run `agentx upgrade` (it
#    creates the key from the current callback key) and check again.
#    STOP if the callback key's current version is less than 24 hours old: a rotation is still in its window.

# c. (Optional, once after the 0.5.15 upgrade.) Check that the two secrets hold the same value, without either value
#    entering your context. Use asm-exec with {{resolve:secretsmanager:agentx/staging/callback-signing-key}} and
#    {{resolve:secretsmanager:agentx/staging/erasure-hash-key}}, and print only "same" or "different". Look up the
#    asm-exec syntax in the aws-secrets-manager skill first; it is not written out here.
```

Tell the owner which three functions you'll roll, the time of the rotation, and that tokens signed in the last 24
hours keep working.

## 2. Put the new key (write; needs the owner's go)

The value comes from Secrets Manager's own generator and goes into a private temporary file. It never reaches the
screen or a command line.

```sh
umask 077; F=$(mktemp)
# tr strips the newline --output text adds, so the stored key is exactly the 64 generated characters.
$S aws secretsmanager get-random-password --password-length 64 --exclude-punctuation --query RandomPassword --output text | tr -d '\n' > "$F"
$S aws secretsmanager put-secret-value --secret-id agentx/staging/callback-signing-key --secret-string "file://$F" --query '{VersionId: VersionId, Stages: VersionStages}'
rm -f "$F"
```

Run `describe-secret` again. There should be a new `AWSCURRENT` version, and the old one should now be
`AWSPREVIOUS`. Go straight on to step 3.

## 3. Roll the functions (write; MANDATORY, right after step 2)

Between step 2 and the end of step 3 there's a short `CALLBACK_FORBIDDEN` gap. A new execution environment issues
tokens with the new key, and a warm one, still on the old key, refuses them. Keep the gap to the minute or two this
loop takes. A worker callback refused in that gap is retried by the worker or cleaned up by the reconciler.

A configuration change sends new invocations to fresh execution environments, and those read the new version.
`Description` isn't set in the templates, so changing it doesn't fight CloudFormation.

```sh
for FN in <broker function> <eval batch tick function> <session reconciler function>; do
  $S aws lambda update-function-configuration --function-name "$FN" --description "callback signing key rolled $(date -u +%Y-%m-%dT%H:%MZ)" --query LastUpdateStatus
  $S aws lambda wait function-updated --function-name "$FN"
done
```

## 4. Verify

- `GET /health` on the control plane answers 200.
- The broker's log group has no `the callback signing key could not be read` and no `the erasure hash key could not
  be read` lines in the 10 minutes after the roll.
- Run one small task end to end (the owner's $1 task). Its worker callbacks must be accepted (no
  `CALLBACK_FORBIDDEN` in the broker log), and it must finish.
- The reconciler's next scheduled run must log no `stuck_cancel` or `unwaited_task.cancel_failed` errors about
  signing.

If any check fails, roll back:

1. With admin credentials, move `AWSCURRENT` back to the old version:
   `update-secret-version-stage --secret-id agentx/staging/callback-signing-key --version-stage AWSCURRENT --move-to-version-id <old id> --remove-from-version-id <new id>`.
2. Repeat step 3.

Tokens signed with the new key during that short time then stop verifying. That's acceptable: they're
short-lived, and the reconciler cleans up the tasks they belonged to.

## 5. Drop the previous key

You don't have to do anything. After 24 hours, readers stop accepting the previous key by themselves. To end the
overlap sooner, remove its label with admin credentials (the operator role can't do this), then repeat step 3:

```sh
$S aws secretsmanager update-secret-version-stage --secret-id agentx/staging/callback-signing-key --version-stage AWSPREVIOUS --remove-from-version-id <previous version id>
```

Record the rotation time and both version ids in the release notes. Never record the values.
