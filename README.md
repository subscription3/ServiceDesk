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
   - `Sites.Manage.All` (needed only so `npm run setup` can create the lists and columns; you can remove it afterwards)

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

## Day to day

**Adding a new agent** takes two steps:
1. Give them the **Service Desk Agent** role in Entra, so they can open the desk.
2. Add them in **Settings**, so tickets can be assigned to them.

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
scripts/
  setup-sharepoint.mjs  Creates the SharePoint lists (npm run setup)
  copy-msal.mjs         Build step that bundles the Microsoft sign-in library
```
