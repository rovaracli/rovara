# Companies and projects

This guide covers company setup, GitHub, project organization, roles, Archive and Restore, and current AI spending controls in Rovara Cloud.

These steps work once your Rovara administrator sets `COMPANY_SIGNIN=enabled`. Until then, Rovara says a feature is not available yet.
<!-- Source: PrepLabsAI/Rovara#823; PrepLabsAI/Rovara#830; PrepLabsAI/Rovara#835; PrepLabsAI/Rovara#839. -->

## Sign in with GitHub

When your Rovara administrator enables GitHub sign-in, choose **GitHub** on the sign-in page. The sign-in page is part of your Rovara installation; GitHub sign-in requires both `COMPANY_SIGNIN=enabled` and GitHub sign-in enabled for the installation. To join a company, use an invite or ask an owner or admin to pre-approve your verified GitHub email. This is separate from connecting a GitHub organization for project repositories.
<!-- Source: PrepLabsAI/Rovara#831; PrepLabsAI/Rovara#834; PrepLabsAI/Rovara#846; docs/rovara-cloud-install.md; packages/ui/src/screens/admin/access/SignInClientsScreen.tsx. -->

## Start or join a company

To create a company, sign in to Rovara Cloud, choose **Create your company**, enter a name, and use a company invite code from your Rovara administrator. A code is single-use. After creation, sign in again to enter the new company.
<!-- Source: PrepLabsAI/Rovara#823; PrepLabsAI/Rovara-cloud#87. -->

An owner or admin opens **Invites**, enters the teammate's email, creates the invite, and copies the link. Rovara does not email it, so send it yourself. You can also choose **Anyone with the link**; anyone who gets that link can join as a member, so share it privately. The link lets the teammate sign in and join. Invites are for members only during the pilot; an owner can make someone an admin after they join. An invite expires after seven days and works once.
<!-- Source: PrepLabsAI/Rovara-cloud#87; PrepLabsAI/Rovara-cloud#91. -->

Linking Linear from a project is coming soon.
<!-- Source: packages/ui/src/screens/setup/ProjectChecklist.tsx; PrepLabsAI/Rovara-cloud#97. -->

## Add Rovara to Slack and link a channel

During company setup, choose **Add to Slack** and approve Rovara in the workspace; you can choose **Set up later** and add it from **Company settings → Connections**. Then open the project's setup checklist or settings, choose its Slack channel, and link it. For a private channel, invite Rovara to the channel and press **Check**. A new channel replaces the project's existing link. Unlinking does not stop threads already in progress.
<!-- Source: packages/ui/src/screens/connect/SlackConnect.tsx; packages/ui/src/screens/connect/SlackChannelRow.tsx; packages/ui/src/screens/setup/ProjectChecklist.tsx; packages/ui/src/screens/connect/ProjectIntegrations.tsx; packages/cloud-server/src/slack-connect.ts; PrepLabsAI/Rovara-cloud#97; PrepLabsAI/Rovara#865; PrepLabsAI/Rovara#866. -->

## Connect GitHub and choose repositories

A company owner or admin connects GitHub. For an organization installation, the person connecting must also be an active admin of that GitHub organization. Follow GitHub's sign-in and permission steps, then choose the GitHub connection to claim in Rovara Cloud.
<!-- Source: PrepLabsAI/Rovara#830; PrepLabsAI/Rovara#832; PrepLabsAI/Rovara-cloud#92. -->

Choose one or more repositories. By default, several repositories become one Rovara project. Above 8 selected repositories, Rovara preselects separate projects. You can choose one project per repository and select at most 32 repositories at a time. A company owner or admin can create projects once GitHub is connected. A Rovara administrator (the person who runs your Rovara installation) can create projects too. Company-created project names are unique within that company.
<!-- Source: PrepLabsAI/Rovara#837; PrepLabsAI/Rovara#847; PrepLabsAI/Rovara#849. -->

## Roles

- **Owner:** can do what an admin can, create projects, make or change owners, and disconnect GitHub when no project still uses it.
- **Admin:** can connect GitHub, create projects, create invites, and make people members or admins. An admin cannot change an owner's role.
- **Member:** can work in projects they have access to. Members cannot use company administration controls.
- **Project admin:** can administer the project they were granted access to. Project admins can archive and restore that project in its **Settings** tab.

Only an owner can make or change an owner's role. At least one company owner must remain. GitHub connection, the company AI model, and company spending settings are owner/admin tasks. Removing a teammate from the company is coming soon in the app.
<!-- Source: PrepLabsAI/Rovara-cloud#86; PrepLabsAI/Rovara-cloud#87; PrepLabsAI/Rovara-cloud#93; PrepLabsAI/Rovara#830; PrepLabsAI/Rovara#832; PrepLabsAI/Rovara#835; PrepLabsAI/Rovara#839; PrepLabsAI/Rovara-cloud#94. -->

## Archive and restore a project

Open the project's **Settings** tab, then **Archive or restore**, and review what will happen before confirming. Archive stops new work and stops a running task at its next round. It deletes nothing. Restore makes the project available for new work again. Both actions can be previewed before you confirm them.
<!-- Source: PrepLabsAI/Rovara#839; PrepLabsAI/Rovara-cloud#94. -->

In the project's **Settings** tab, open **Archive or restore**. Company owners and admins, and admins of that project, can use it. A regular project user can view the preview but cannot make the change. Archiving is not available yet for companies whose tasks have not moved to Rovara's new task engine. In the project's **Settings** tab, **Re-run setup** checks how the project installs and tests. A re-run only proposes a new setup; the working one stays until someone confirms it. Removing a project is coming soon.
<!-- Source: PrepLabsAI/Rovara#839; PrepLabsAI/Rovara#844; PrepLabsAI/Rovara-cloud#94. -->

## Company AI model and spending limits

Each company chooses its own AI model from the models offered to that company. Owners and admins can change the company model; members can view it. If a company never picks a model, Rovara uses the default for the installation. If the selected model is no longer offered, new tasks are refused until someone picks another.
<!-- Source: PrepLabsAI/Rovara#835; PrepLabsAI/Rovara-cloud#96. -->

The company has a monthly spending limit. The AI and spending screen shows the saved company limit, or a $500 default when no limit is saved. A change to the monthly limit may need another admin to approve it. A project admin can save a per-task limit for a project. Rovara does not apply it to tasks yet; that is coming soon. If your company has set a per-task cap, a project limit cannot be higher than it. A separate project monthly limit is not available yet; coming soon.
<!-- Source: PrepLabsAI/Rovara-cloud#96. -->
