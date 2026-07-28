---
name: setup-github-app
description: Use when a user needs to create and wire up the GitHub App that drives a cdk-github-microvm-runners runner set — creating the App with the exact permissions and webhook, storing its credentials in Secrets Manager, installing it on an org, and verifying the installation. Runs the manifest-flow helper that collapses the manual GitHub App gauntlet into two clicks.
---

# Set up the GitHub App for a MicroVM runner set

A `cdk-github-microvm-runners` runner set needs a GitHub App: it receives
`workflow_job` webhooks and calls the runner API to mint just-in-time
runner registrations. Creating that App by hand is a long, error-prone
click-path with two traps that silently break setup. This skill runs a
helper that pre-fills everything through GitHub's **App Manifest flow**, so
the human only clicks **Create** and **Install**.

## The two traps this automates around

1. **The `workflow_job` event is gated on the `Actions: read` permission.**
   Without that permission, GitHub won't even offer the event to subscribe
   to — so a hand-built App silently never delivers webhooks. The manifest
   requests both, so the event is always available.
2. **Two-truths: the App vs. the installation.** Changing an App's
   permissions does **not** change what an existing installation grants
   until an **org owner accepts** the new permissions. Verification must
   read the _installation_, not the App — which is exactly what the helper's
   verify step (and `--doctor`) does.

## Prerequisites

- **Deploy the runner set first.** The helper reads the webhook URL from the
  stack's `WebhookUrl` output, so the CloudFormation stack must already
  exist. (You can instead pass `--webhook-url` directly.) The stack deploys
  before these secrets exist: it references all three by name and the handlers
  read them at run time, so one deploy and one run of this helper is the whole
  setup — no redeploy, and nothing copied by hand.
- AWS credentials for the account holding the runner set (the helper writes to
  Secrets Manager). Pass `--profile` / `--region` or set the usual env vars.
- Node 18+ and a browser on the machine running this (the flow opens two
  browser pages).
- The user must be an **owner** of the target GitHub org (App creation and
  install both require org-owner rights).

## Steps

1. **Gather inputs.** You need:
   - `--org` — the GitHub org the runners serve.
   - `--stack` — the deployed runner set's CloudFormation stack name (or
     `--webhook-url` if you have the URL directly).
   - `--secret-prefix` — where to store credentials (default `microvm-runner/dev`).
     The construct's `github` prop must point at these same secret names:
     `<prefix>/app-id`, `<prefix>/app-private-key`, `<prefix>/webhook-secret`.

     ```ts
     github: GithubAuth.app({
       appId: GithubAppId.fromSecret(appIdSecret),
       privateKey: GithubAppKey.fromSecret(privateKeySecret),
       webhookSecret,
     }),
     ```

   - `--app-name` — a globally-unique GitHub App name (default `microvm-runner`).
   - `--profile` / `--region` for AWS if not set in the environment.

2. **Run the helper.** `cdk deploy` prints the exact command as the runner
   set's `SetupCommand` output, carrying the scope, stack, and region that
   runner set was built with — prefer that line over assembling flags:

   ```bash
   npx cdk-github-microvm-runners setup \
     --org <org> \
     --stack <stack-name> \
     --secret-prefix microvm-runner/dev \
     --app-name <unique-app-name> \
     --profile <aws-profile> --region <region>
   ```

   The helper ships as the package's command, so this is the same line from a
   TypeScript or Python project. From a clone of this repository,
   `node scripts/setup-github-app.mjs` takes the same flags. A runner set
   scoped to repositories rather than an organization uses `--account <login>`
   in place of `--org`.

   Every run reads the stored secrets and the installation first and then does
   what is missing, so the same command is first-time setup, a health check,
   and a diagnosis. With nothing stored yet it creates the App, and what
   happens then — tell the user to watch their browser:
   - A browser tab opens and auto-submits the pre-filled manifest. The user
     clicks **Create GitHub App**.
   - GitHub redirects to a localhost callback; the helper exchanges the
     one-time code for the App id, private key, and GitHub-generated webhook
     secret, and writes all three to Secrets Manager.
   - A second tab opens the **Install** page. The user clicks **Install** and
     selects the org (all repos, or a subset).
   - The helper polls the installation and verifies it grants
     `actions:read`, `organization_self_hosted_runners:write`, and the
     `workflow_job` event. On success it prints the green check and exits 0.

3. **If verification fails** with a permissions/acceptance message: an org
   owner needs to accept the App's requested permissions at
   `https://github.com/organizations/<org>/settings/installations`. Once they
   have, run the same command again — it reads the installation afresh and
   reports.

4. **Check an existing setup** with the same command. It reports on the stored
   credentials, the installation's permissions and event subscription, and the
   webhook endpoint. `--doctor` limits a run to that report and creates
   nothing:

   ```bash
   npx cdk-github-microvm-runners setup --doctor \
     --org <org> --stack <stack-name> --secret-prefix microvm-runner/dev \
     --profile <aws-profile> --region <region>
   ```

   Exit code 0 = healthy; 2 = the installation is missing a permission or
   the event (the message says which). Reach for this before debugging
   webhook-delivery issues.

## Notes

- The helper is safe to re-run. It reads the three secrets and the App
  installation before it does anything, and creates an App only when none of
  them is stored — so a second run against a working setup reports on it
  rather than making a second App. To deliberately create a fresh App, delete
  the three secrets first, and give it an `--app-name` no other GitHub App is
  using.
- GitHub does not expose App _creation_ via API — a human click is required
  once by design. The manifest flow is the most that can be automated; this
  skill automates all of it except the two clicks.
- The private key GitHub returns at conversion time is shown **once**. The
  helper stores it immediately in Secrets Manager; it is never written to
  disk.
