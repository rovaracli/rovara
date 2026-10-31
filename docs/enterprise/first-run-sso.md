# First run: company sign-in on a new Enterprise install

A new Enterprise install has nobody who can sign in: with no group mapping every sign-in is refused, and the admin page needs a signed-in admin. The installer
therefore runs one command, once, with their own AWS credentials (a session of the install's deploy or operator role, in the install's account).

1. Deploy the install as Enterprise (`rovara init --engine cdk --source <checkout> --edition enterprise`).
2. Turn on the company sign-in: `rovara signin enable oidc ...`. Make sure your identity provider puts a groups claim in the ID token for the people who will use Rovara.
3. Look up the identity provider's subject (`sub`) of the one or two people who will own the install.
4. Run the plan, then write it:

   ```
   rovara --env <env> sso bootstrap --claim groups \
     --admin-group rovara-admins --member-group rovara-users \
     --owner-subject <sub-of-owner-1> [--owner-subject <sub-of-owner-2>] [--break-glass-days 30]
   rovara --env <env> sso bootstrap ...same flags... --yes
   ```

What it does: makes the named people owners; writes the first group mapping (admin groups become the admin role, member groups the member role; a mapping never grants
owner); writes the emergency sign-in list (the owners, expiring in 1 to 90 days); records all of it in the audit ledger (as pending items the install's audit drain delivers).

What you must do at the identity provider: put each owner in one of the admin groups. An owner who is in no mapped group is refused, like anyone else.

It refuses to run again once a mapping or an emergency list exists, so it cannot change a running install. After that, change the mapping and the emergency list from the
admin page (a live browser session with a sign-in made in the last few minutes). The emergency list lets a listed owner in only when the mapping itself is missing or
unreadable, never because a person is in no group; renew it before it expires.
