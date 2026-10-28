# InfraCredit Service Desk

A ticketing system in the style of Zoho Desk, built on services you already use:

| Part | What it does |
|---|---|
| **Netlify** | Hosts the website and runs the backend (Netlify Functions). Deploys automatically from GitHub. |
| **GitHub** | Stores the code. Every push to `main` redeploys the site. |
| **SharePoint Lists** | The database: tickets, conversations, activity log and settings. |
| **Microsoft 365 sign-in** | Staff sign in with their work account. The *Service Desk Agent* role decides who gets the agent desk. |
| **Shared mailbox** (e.g. `servicedesk@infracredit.ng`) | Sends every notification and receives requests. New emails become tickets automatically. |

## How requests come in and how people are notified

There are three ways to raise a ticket:

1. **Self-service portal.** Staff sign in and fill in a form, and a ticket is created instantly.
2. **Email.** Anyone, inside or outside InfraCredit, emails the support mailbox. Every 5 minutes, new emails become tickets.
3. **Agent desk.** Agents log phone calls, walk-ins and WhatsApp messages by hand.

Requesters receive an email when:
- their ticket is created (with the ticket number),
- an agent replies (the reply is in the email),
- the status changes (in progress, on hold, escalated, resolved),
- the ticket is assigned.

They can also follow everything in the portal under **My requests**.

Agents receive an email when a ticket is assigned to them and when the requester replies.

The mailbox handles replies in both directions:
- **Requester replies.** When a requester replies to a notification email, the reply is added to the ticket. If the ticket was closed or on hold, it reopens. The `[#1001]` tag in the subject links the email to the ticket.
- **Agent replies.** When an agent replies to an assignment email, the reply is sent on to the requester as an agent reply.
- **Ignored mail.** Out-of-office replies, bounces and no-reply senders are skipped.

---

## Before you start

You need:
- A Microsoft 365 admin. Setting up the app registration needs a Global Administrator, or an Application Administrator plus an Exchange Administrator.
- A GitHub account and a Netlify account. Netlify's free tier is enough to start.
- Node.js 20 or newer on your computer, to run the one-time SharePoint setup.

---

## Step 1: Create the SharePoint site

1. Go to SharePoint and select **Create site** → **Team site** (or **Communication site**). Name it something like `Service Desk`.
2. Note the site address, e.g. `https://infracredit.sharepoint.com/sites/ServiceDesk`. This gives you:
   - `SHAREPOINT_HOSTNAME` = `infracredit.sharepoint.com`
   - `SHAREPOINT_SITE_PATH` = `/sites/ServiceDesk`
3. Limit who can open the site directly. Only the app and IT admins need access, because everyone else uses the service desk website. If staff are site members, they could read every ticket in SharePoint.

You don't create the lists by hand. Step 5 does that.

## Step 2: Create the shared mailbox

1. In the **Exchange admin center**, go to **Recipients** → **Mailboxes** → **Add a shared mailbox**.
2. Name it `Service Desk` with the address `servicedesk@infracredit.ng`. A shared mailbox needs no licence.
3. This address becomes `SUPPORT_MAILBOX`.

## Step 3: Register the app in Microsoft Entra ID

Go to **entra.microsoft.com** → **Applications** → **App registrations** → **New registration**.

1. **Name:** `InfraCredit Service Desk`. **Supported account types:** *Accounts in this organizational directory only*. Leave the redirect URI empty for now and select **Register**.
2. On the **Overview** page, copy the **Application (client) ID** into `AZURE_CLIENT_ID` and the **Directory (tenant) ID** into `AZURE_TENANT_ID`.
3. **Authentication** → **Add a platform** → **Single-page application**, then add these redirect URIs:
   - `http://localhost:8888/`
   - Your Netlify address, which you'll get in Step 6, e.g. `https://infracredit-servicedesk.netlify.app/`
   - Your custom domain if you use one, e.g. `https://servicedesk.infracredit.ng/`
4. **Token configuration** → **Add optional claim** → **ID** → tick **email** → **Add**. If Entra asks, also tick the box to turn on the Microsoft Graph email permission.
5. **App roles** → **Create app role**:
   - Display name: `Service Desk Agent`
   - Allowed member types: **Users/Groups**
   - Value: `ServiceDesk.Agent` (it must be exactly this)
   - Description: `Can work on tickets in the service desk`
6. **Certificates & secrets** → **New client secret**, valid for 24 months. Copy the **Value** right away, because it's only shown once. It goes in `AZURE_CLIENT_SECRET`. Set a calendar reminder to replace it before it expires.
7. **API permissions** → **Add a permission** → **Microsoft Graph** → **Application permissions**, then add:
   - `Sites.ReadWrite.All` (read and write the SharePoint lists)
   - `Mail.Send` (send notifications)
   - `Mail.ReadWrite` (read the support inbox and mark emails as processed)
   - `Sites.Manage.All` (needed whenever `npm run setup` creates lists or columns, including after upgrades and on restore-test sites)

   Then select **Grant admin consent for InfraCredit**.
8. Go to **Enterprise applications** → `InfraCredit Service Desk` → **Users and groups** → **Add user/group**. Choose your support agents, or better, a group such as `Service Desk Agents`, and give them the **Service Desk Agent** role.

   Everyone else can still sign in and use the request portal. Leave **Properties** → *Assignment required?* set to **No**.

### Recommended: limit what the app can reach

As set up above, the app could send mail as any mailbox and write to any SharePoint site. Lock it down once everything works.

**Email: restrict the app to the support mailbox only.** Do this in Exchange Online PowerShell:

```powershell
Connect-ExchangeOnline
# A mail-enabled security group containing only the service desk mailbox
New-DistributionGroup -Name "Service Desk App Scope" -Type Security -Members servicedesk@infracredit.ng
New-ApplicationAccessPolicy -AppId <AZURE_CLIENT_ID> -PolicyScopeGroupId "Service Desk App Scope" -AccessRight RestrictAccess -Description "Service desk app may only use the service desk mailbox"
Test-ApplicationAccessPolicy -Identity servicedesk@infracredit.ng -AppId <AZURE_CLIENT_ID>   # should say Granted
Test-ApplicationAccessPolicy -Identity someone.else@infracredit.ng -AppId <AZURE_CLIENT_ID>  # should say Denied
```

Microsoft is moving these policies to *RBAC for Applications in Exchange Online*. Either approach works.

**SharePoint: restrict the app to the Service Desk site.**
1. Replace `Sites.ReadWrite.All` with `Sites.Selected` and grant admin consent again.
2. Give the app access to just this site, using PnP PowerShell:

```powershell
Connect-PnPOnline -Url https://infracredit-admin.sharepoint.com -Interactive -ClientId <a PnP app id>
Grant-PnPAzureADAppSitePermission -AppId <AZURE_CLIENT_ID> -DisplayName "InfraCredit Service Desk" -Site https://infracredit.sharepoint.com/sites/ServiceDesk -Permissions FullControl
```

Run `npm run setup` (Step 5) first, while the broader permission is still in place. Once the lists exist, you can lower the site permission from `FullControl` to `Write`.

## Step 4: Put the code on GitHub

1. Create a **private** repository on GitHub, e.g. `infracredit-service-desk`.
2. Unzip this project, then from inside the folder run:

```bash
git init
git add .
git commit -m "InfraCredit Service Desk"
git branch -M main
git remote add origin https://github.com/<your-org>/infracredit-service-desk.git
git push -u origin main
```

The `.gitignore` already keeps `.env` (your secrets) and `node_modules` out of GitHub. Never commit the client secret.

## Step 5: Create the SharePoint lists

Do this once, from your computer:

```bash
npm install
cp .env.example .env      # on Windows: copy .env.example .env
# open .env and fill in every value from Steps 1–3
npm run setup
```

The script creates four lists on the site (`SD Tickets`, `SD Ticket Messages`, `SD Ticket Events`, `SD Settings`) with all their columns and indexes, plus default settings. It's safe to run again: it only adds what's missing.

### Optional: try it on your computer

```bash
npm install -g netlify-cli
npm run dev
```

Then open http://localhost:8888. The scheduled email check doesn't run locally, so use **Settings** → **Check mailbox now** instead.

## Step 6: Deploy on Netlify

1. In Netlify, select **Add new site** → **Import an existing project** → **GitHub**, then choose the repository. The build settings are read from `netlify.toml`, so leave them as they are.
2. Before the first deploy, go to **Site configuration** → **Environment variables** and add:

   | Variable | Value |
   |---|---|
   | `AZURE_TENANT_ID` | from Step 3 |
   | `AZURE_CLIENT_ID` | from Step 3 |
   | `AZURE_CLIENT_SECRET` | from Step 3 (mark it as **secret**) |
   | `SHAREPOINT_HOSTNAME` | e.g. `infracredit.sharepoint.com` |
   | `SHAREPOINT_SITE_PATH` | e.g. `/sites/ServiceDesk` |
   | `SUPPORT_MAILBOX` | e.g. `servicedesk@infracredit.ng` |
   | `ORG_NAME` | `InfraCredit` |
   | `SITE_URL` | the site's public address, e.g. `https://servicedesk.infracredit.ng` (used in email links) |
   | `AGENT_EMAILS` | optional: comma-separated emails that get the agent desk even without the Entra role |

3. Deploy. Copy the site address (`https://<name>.netlify.app`) and add it as a redirect URI in Entra, as in Step 3.3, including the trailing `/`.
4. **Optional custom domain:** in Netlify, go to **Domain management** → **Add a domain**, e.g. `servicedesk.infracredit.ng`. Add the CNAME record at your DNS provider. Then add the new address to the Entra redirect URIs and update `SITE_URL`.
5. Under **Logs** → **Functions**, you should see `email-poll` listed as a scheduled function that runs every 5 minutes.

## Step 7: First run checklist

1. Sign in as an agent. Open **Settings** and add each agent's name and work email so tickets can be assigned to them. Adjust departments and response targets too.
2. Sign in as a normal staff member, or open **Request portal** from the agent desk. Raise a test request.
   - You should get a confirmation email.
   - The ticket should appear on the agent desk.
3. On the agent desk, reply to the ticket and change its status. The requester should get an email for each.
4. From any mailbox, send an email to `servicedesk@infracredit.ng`. Within 5 minutes, or right away using **Check mailbox now**, it becomes a ticket and the sender gets an acknowledgement.
5. Reply to one of the notification emails. The reply should show up on the ticket.

---

## Settings (admins only)

Open **Settings** in the side navigation. It has five sections:

| Section | What you can do |
|---|---|
| **Users** | Add agents and admins, change roles, remove people. Search finds people in your Microsoft 365 directory. |
| **SLA policy** | Set first-response and resolution targets per priority, the warning point (amber), business hours, time zone and public holidays. |
| **Departments** | Add or remove the teams requests are routed to. |
| **Branding** | Upload or replace the logo (PNG or JPG, under 1 MB). It's stored in the SharePoint site and appears in the top bar, on the sign-in page and in every email. |
| **Email** | See the support mailbox details and check it for new emails right away. |

### Who can do what

| Role | Gets | How someone gets it |
|---|---|---|
| **Admin** | Agent desk plus Settings | Admin role in **Settings → Users**, or the `ServiceDesk.Admin` app role in Entra, or listed in the `ADMIN_EMAILS` environment variable |
| **Agent** | Agent desk | Added in **Settings → Users**, or the `ServiceDesk.Agent` app role in Entra, or listed in `AGENT_EMAILS` |
| **Staff** | Request portal | Anyone else in the organisation who signs in |

**First-time setup:** until at least one admin has been added in Settings → Users, anyone with the `ServiceDesk.Agent` Entra role is treated as an admin. Add yourself as an admin first.

### Optional: directory search when adding users

To search the Microsoft 365 directory by name in Settings → Users, add one more permission:
1. In Entra, open your app → **API permissions** → **Add a permission** → **Microsoft Graph** → **Application permissions**.
2. Tick **User.Read.All**, then select **Add permissions** → **Grant admin consent**.

Without it, you can still add people by typing their name and email.

### Fallback logo file

If you'd rather ship the logo with the code, put `logo.png` in `public/brand/`. A logo uploaded in Settings takes priority.

## Customer feedback (CSAT)

When a ticket is closed, the requester's email includes **How did we do?** with five one-click ratings, from 1 (very dissatisfied) to 5 (very satisfied).
- **Rating from the email.** Clicking a rating opens a short page where the requester can add a comment. It doesn't need a sign-in, because the link is signed and expires after 30 days.
- **Rating in the portal.** Staff can also rate closed requests in the portal under **My requests**, and change their rating later.
- **Where ratings show.** Agents see the rating on the ticket. The dashboard shows the **CSAT score** (the share of 4 and 5 ratings, the industry-standard measure), the average rating and the latest comments.

Optional: set a `FEEDBACK_SECRET` environment variable in Netlify to any long random text. Otherwise the links are signed with a key derived from the app secret, and rotating the client secret will expire the links already sent.

## Activity log (audit trail)

**Settings → Activity log** records, with the person, time, IP address and device:
- sign-ins
- tickets created, updated (with old and new values), replied to, noted and deleted
- emails turned into tickets or replies
- ratings
- every settings change (users added, removed or re-roled; SLA before and after; departments; logo)
- mailbox checks, backups, restores, and exports of the log itself

Admins can filter by date, category or person and **export to CSV**. The desk can only add entries, never edit or delete them. The log is stored in the `SD Audit Log` SharePoint list and included in every backup.

## Backups and audit evidence

### What protects the data

| Layer | What it covers | Set up by |
|---|---|---|
| **Nightly backup** (this project) | All six lists, copied every night at 02:00 Lagos time into `ServiceDeskBackups/<date>` on the SharePoint site, then read back and verified | GitHub Actions, see below |
| **Second copy in GitHub** | The same files, kept for 90 days as a private workflow artifact | Automatic with the nightly backup |
| **SharePoint version history and recycle bin** | Earlier versions of every item, and deleted items for 93 days | On by default |
| **Microsoft Purview retention policy** (recommended) | Stops anyone, including admins and the app, from permanently deleting backups or list data before the retention period ends | Microsoft 365 compliance admin |
| **Code** | Every version of the application in GitHub, plus every deploy in Netlify (one-click rollback) | Already in place |

### Set up the nightly backup (once)

1. In GitHub, open the repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Add these five secrets, with the same values as in Netlify:
   - `AZURE_TENANT_ID`
   - `AZURE_CLIENT_ID`
   - `AZURE_CLIENT_SECRET`
   - `SHAREPOINT_HOSTNAME`
   - `SHAREPOINT_SITE_PATH`
2. Optionally, on the **Variables** tab:
   - `BACKUP_RETENTION_DAYS`, e.g. `400`. Backups older than this are deleted. Leave it unset to keep every backup, and let your retention policy decide.
   - `GITHUB_COPY_RETENTION_DAYS`, which defaults to 90.
   - `KEEP_GITHUB_COPY` = `false`, if policy requires the data to stay only in Microsoft 365.
3. Open **Actions** → **Nightly backup** → **Run workflow** to take the first backup now. It should finish with a green tick, and the backup appears in **Settings → Backups** in the desk.
4. Make sure failure emails reach you: in GitHub, go to your profile → **Settings** → **Notifications** → **Actions**, and turn on notifications for failed workflows.

### What auditors can be shown

Each backup folder contains:
- `manifest.json`: every file with its record count, size and **SHA-256 hash**, with confirmation that each file was read back from SharePoint and matched.
- `evidence-report.html`: the same information in a readable report, with instructions for checking any file's hash independently (`certutil -hashfile <file> SHA256` on Windows).
- The data itself as JSON, plus `tickets.csv` for opening in Excel.

Further evidence:
- **Activity log.** Each backup adds an entry to the activity log with the manifest hash, so a backup file that was changed afterwards can be detected.
- **GitHub run history.** GitHub keeps the full run history and logs for every backup: the date, the result, who started it, and a summary with the hashes.
- **Settings → Backups** shows the last verified backup, backups in the last 30 days, every run's result and hash, and the last restore test. It warns when no verified backup has run for over a day.

### Prove that restore works (recommended every quarter)

1. In SharePoint, create an empty test site, e.g. `/sites/ServiceDesk-RestoreTest`.
2. In GitHub, open **Actions** → **Restore test** → **Run workflow**.
3. Enter `latest` (or a backup ID such as `20261028-0100Z`) and the test site path.

The workflow downloads the backup, checks every hash, creates the lists on the test site and restores everything. The restore keeps the original ticket numbers and dates and relinks conversations, history and feedback. It then records the result in the activity log and **Settings → Backups**. It refuses to run against the live site.

### Restoring for real

If the live data is lost or damaged:
1. Create a new SharePoint site, or empty the lists.
2. On your computer, run:
   ```
   npm run download-backup -- latest
   ```
   Or download a backup folder from SharePoint or GitHub into `restore-input/<backup ID>`.
3. Point `SHAREPOINT_SITE_PATH` in `.env` at the new site, then run:
   ```
   npm run setup
   npm run restore -- restore-input/<backup ID>
   ```
4. Update `SHAREPOINT_SITE_PATH` in Netlify (and in the GitHub secrets) and redeploy.

The restore stops if any file fails its hash check, and it will only write into empty lists.

### Recommended: a retention policy in Microsoft Purview

Ask your Microsoft 365 compliance admin to create a retention policy for the service desk SharePoint site, for example **retain for 7 years**. It then covers:
- the lists
- the `ServiceDeskBackups` folder
- the activity log

With the policy in place, deleted or changed items are kept in the site's Preservation Hold library until the period ends. That's the evidence auditors usually ask for, because nobody can quietly delete records.

### Data protection

Backups contain personal data (names, emails and conversations), so treat them like the live desk under the NDPA (Nigeria Data Protection Act):
- Keep the GitHub repository private.
- Limit who can open the SharePoint site.
- Set `KEEP_GITHUB_COPY` to `false` if your policy requires the data to stay only in Microsoft 365.

## Day to day

**Adding a new agent:** go to **Settings → Users**, find the person and add them as an Agent. They can open the desk the next time they sign in.

**Client secret expiry.** When the secret nears expiry, create a new one in Entra, update `AZURE_CLIENT_SECRET` in Netlify and redeploy.

**SharePoint limits.** The lists use indexed columns, so they work comfortably into the thousands of tickets. Every year or two, export old closed tickets to Excel and delete them to keep the desk fast.

**Updates in the browser.** The desk refreshes every 30 seconds. Email notifications go out immediately.

**Attachments.** Files attached to incoming emails aren't copied into tickets yet. Agents can still see them in the shared mailbox.

## Troubleshooting

**Start here:** open `https://<your-site>/api/health` in a browser. It tests each connection in order and tells you which setting is wrong. It never shows secret values. The same detailed errors appear in Netlify under **Logs** → **Functions** → **api**.

| What you see | Likely cause |
|---|---|
| `/api/health` says the client secret looks like a Secret ID | In Entra, two values appear next to each secret. `AZURE_CLIENT_SECRET` needs the **Value**, not the **Secret ID**. If you no longer have the Value, create a new secret. |
| "The server isn't configured yet" | An environment variable is missing in Netlify. Redeploy after adding it. |
| Microsoft sign-in error AADSTS50011 | The site address isn't in the Entra SPA redirect URIs. Check the exact address, including the trailing `/`. |
| Signed in, but only the portal shows for an agent | The person doesn't have the **Service Desk Agent** role yet. Sign out and back in after it's assigned. |
| "SharePoint list … was not found" | `npm run setup` hasn't been run against this site, or the site path is wrong. |
| `npm run setup` fails with 403 on `/lists` | The app needs `Sites.Manage.All` (application) with admin consent to create lists. Also check that the site path in `.env` matches Netlify. |
| Graph error 403 in the function logs | Admin consent is missing, or an access policy is blocking the mailbox or site. |
| No emails are going out | Check `SUPPORT_MAILBOX` and the `Mail.Send` permission. Errors are logged in Netlify under **Functions** → **api**. |
| Emails aren't turning into tickets | Check the **email-poll** function logs. Scheduled functions run only on the published production deploy. |

## Project layout

```
public/                 Website (agent desk + request portal)
  index.html            Page shell and dialogs
  app.js                All the screens and logic
  styles.css            InfraCredit navy and green styling
netlify/functions/
  api.mjs               /api/* endpoints used by the website
  email-poll.mjs        Runs every 5 minutes: turns emails into tickets
lib/
  auth.mjs              Checks the Microsoft sign-in and agent role
  graph.mjs             Microsoft Graph connection
  lists.mjs             SharePoint list reads and writes
  tickets.mjs           Ticket rules, SLA and notifications
  mail.mjs              Email templates and sending
  inbox.mjs             Reading the support mailbox
  audit.mjs             Activity log
  feedback.mjs          Ratings and signed feedback links
  sla.mjs               SLA targets, business hours and holidays
  schema.mjs            Columns of every SharePoint list
scripts/
  setup-sharepoint.mjs  Creates the SharePoint lists (npm run setup)
  backup.mjs            Backs up, verifies and writes the evidence report (npm run backup)
  download-backup.mjs   Downloads a backup from SharePoint (npm run download-backup -- latest)
  restore.mjs           Restores a backup into empty lists (npm run restore -- <folder>)
.github/workflows/
  backup.yml            Nightly backup at 02:00 Lagos time, plus an on-demand button
  restore-test.yml      Restore test into a separate site, for audit evidence
  copy-msal.mjs         Build step that bundles the Microsoft sign-in library
```
