# Cert Dashboard

A self-hosted web app for tracking certificate expiry across an organization. It keeps a single
inventory of every TLS/SSL, code-signing and internal certificate, warns you before anything
expires, tracks renewal progress, emails a monthly digest, and records every change in an
audit log.

It runs as one small Node.js process with a built-in SQLite database, so there is no separate
database server to install.

---

## Contents

1. [Requirements](#1-requirements)
2. [Install and run](#2-install-and-run)
3. [First sign-in](#3-first-sign-in)
4. [Using the app](#4-using-the-app)
5. [Administration](#5-administration)
6. [Running it for your team](#6-running-it-for-your-team)
7. [Backup and restore](#7-backup-and-restore)
8. [Troubleshooting](#8-troubleshooting)
9. [Reference](#9-reference)

---

## 1. Requirements

- **Node.js 22.5 or newer.** The app uses Node's built-in SQLite module, which older versions
  don't have. Check your version with:

  ```bash
  node --version
  ```

  Download Node.js from https://nodejs.org if you need to install or upgrade it (choose the LTS
  version).
- A modern browser: Chrome, Edge, Firefox or Safari.
- **Optional:** an SMTP account, if you want email digests (Office 365, Google Workspace, SendGrid,
  or an internal mail relay).

No build tools, database server or internet connection are needed to run the app.

---

## 2. Install and run

Open a terminal in the project folder (the folder containing `package.json`).

**Install the dependencies (first time only):**

```bash
npm install
```

**Start the app:**

```bash
npm start
```

You should see:

```
Cert Dashboard running at http://localhost:3000
```

Open **http://localhost:3000** in your browser. To stop the app, press `Ctrl + C` in the terminal.

### Using a different port

Port 3000 is the default. To use another port, set the `PORT` environment variable before
starting.

PowerShell (Windows):

```powershell
$env:PORT = 8080; npm start
```

macOS / Linux:

```bash
PORT=8080 npm start
```

> **Note:** Node prints an `ExperimentalWarning: SQLite is an experimental feature` message on
> start-up. This is expected and harmless.

---

## 3. First sign-in

The first time the app starts, it creates an administrator account and prints its temporary
password in the terminal:

```
========================================================
 Created default admin account
 Username: admin
 Password: <random password>
========================================================
```

The same details are saved to `data/FIRST_RUN_ADMIN_CREDENTIALS.txt`.

1. Go to http://localhost:3000 and sign in as `admin` with that password.
2. You'll be asked to choose your own password (at least 8 characters).
3. **Delete `data/FIRST_RUN_ADMIN_CREDENTIALS.txt`**, since that password no longer works and the
   file shouldn't be left lying around.
4. Go to **Settings** and set your organization name, then add accounts for your team under
   **Users and access** (see [Users and roles](#users-and-roles)).

---

## 4. Using the app

### The Certificates page

This is the main view. It has three parts:

- **Summary cards** show how many certificates fall into each status. Click a card to filter
  the table to that status, and click **Total certificates** to clear the filter.
- **Action required banner** appears when anything is expired or critical. **Review now**
  filters the table to those certificates.
- **Certificate table** has search and filters for status, type, environment and renewal
  stage. Click a column heading to sort, and click it again to reverse the order.

Each certificate has a **status** based on how many days are left before it expires:

| Status | Meaning (default thresholds) |
|---|---|
| Expired | The expiry date has passed |
| Critical | Expires within 7 days |
| Warning | Expires in 8–30 days |
| Upcoming | Expires in 31–90 days |
| Healthy | More than 90 days left |

Administrators can change these day counts (see [Alert thresholds](#alert-thresholds)).

Row actions:

- **Edit** updates the certificate's details.
- **CSR** opens your CSR tool with the certificate's details filled in (see [CSR tool integration](#csr-tool-integration)).
- **History** shows every change made to the certificate, who made it and when.
- **Delete** removes the certificate. It is available to admins only.

### Adding a certificate

Click **Add certificate**. There are two ways to fill in the form:

- **From a certificate file (recommended).** In the *Fill in from a certificate file* box, choose
  the certificate's `.pem`, `.crt` or `.cer` file. The domain, alternative names, issuer,
  organization details and issue/expiry dates are read from the file automatically. Review them,
  add a name and owner, then save. Nothing is saved until you click **Save certificate**.

  > Upload the **certificate** only, never the private key. The app doesn't need it and doesn't
  > store the file itself; only the fields read from it are kept.

- **By hand.** Enter the details yourself. Only **Name**, **Common name** and **Expires on**
  are required.

### Tracking renewals

Each certificate has a **renewal stage**, shown in the table as a label with a 5-step progress
bar:

**Not started → Ticket raised → In progress → Renewed → Verified**

When you start renewing a certificate:

1. Open it with **Edit**.
2. Enter your change-request or ticket number in **Ticket number**. It's shown in the table and
   included in email digests.
3. Move the **Renewal stage** forward as work progresses.
4. Once the new certificate is installed, update **Expires on** to the new date (or upload the
   new certificate file) and set the stage to **Verified**.

Use the **All renewal stages** filter to see, for example, everything that's been ticketed but
not yet renewed.

### Expiry calendar

The **Expiry calendar** page groups certificates by the month they expire. Months with expired
or critical certificates are flagged. Click a month to list its certificates. The current month
is selected automatically, which makes this a good page for monthly renewal planning.

### Importing and exporting (CSV)

**Export CSV** downloads the whole inventory as a spreadsheet file, including the current status
and days left.

**Import CSV** adds certificates in bulk. Start from `sample-certificates.csv` in the project
folder. The columns are:

```
name,common_name,sans,issuer,cert_type,environment,owner_team,organization,org_unit,country,issue_date,expiry_date,ticket_number,workflow_status,notes
```

- **Required columns:** `name`, `common_name`, `expiry_date`. All other columns are optional.
- **Dates** must be year-first, for example `2027-03-15` or `2027/3/15`.
  > **Excel tip:** Excel may reformat dates to `15-03-2027` when you save. Format the date columns
  > as text, or as the `yyyy-mm-dd` custom format, before saving.
- **Column headings** are not case-sensitive, and `Common Name` works the same as `common_name`.
- **`workflow_status`** must be one of `not_started`, `ticket_raised`, `in_progress`, `renewed`,
  `verified`. If left empty it defaults to `not_started`.
- **Duplicates are skipped.** A row with the same common name and expiry date as an existing
  certificate isn't imported twice, so re-importing a file is safe.

After an import you get a summary showing how many rows were imported, how many were skipped as
duplicates, and which rows had problems, with the reason for each. Rows with problems are
skipped; everything else is still imported.

### Changing your password

Click **Password** at the bottom of the sidebar.

---

## 5. Administration

Everything in this section is under **Settings** and is visible to admins only.

### Users and roles

| Role | Can do |
|---|---|
| **Editor** | View everything on the Certificates and Expiry calendar pages; add, edit and import certificates |
| **Admin** | Everything editors can do, plus: delete certificates, change settings, manage users, view the audit log, run discovery |

- **Add a user:** click **Add user**, then enter a username, full name and role. You'll be shown
  a **temporary password** once. Share it with the user securely. They'll have to choose their
  own password at first sign-in, and can't use the app until they do.
- **Reset a password:** click **Reset password** next to the user. They get a new temporary
  password and must change it at next sign-in.
- **Change a role or remove a user:** changes take effect immediately, even if that person is
  signed in at the time. Certificates they created keep their name in the history.
- There must always be at least one admin, and you can't remove your own account.

### Alert thresholds

Set how many days before expiry a certificate becomes **Critical**, **Warning** or **Upcoming**.
The numbers must increase in that order (for example 7, 30, 90). Changes apply straight away to
the dashboard, the calendar, CSV exports and email digests.

### Email notifications

The app can email a **monthly digest** listing the certificates that expire that month, plus
any that have already expired and are still outstanding.

1. Fill in the **SMTP server** details:

   | Provider | Host | Port | Encryption |
   |---|---|---|---|
   | Microsoft 365 | `smtp.office365.com` | 587 | STARTTLS |
   | Google Workspace | `smtp.gmail.com` | 587 | STARTTLS (use an app password) |
   | Internal relay | your relay's hostname | usually 25 or 587 | as configured |

   The SMTP password is write-only: once saved it's never shown again. Leave the field blank
   to keep the current password.
2. Enter the **Recipients** as a comma-separated list, for example a security or operations
   mailbox.
3. Click **Save changes**, then use **Send test email** to confirm delivery works.
4. Turn the **Monthly digest** on and choose the **day of the month** to send it (1–28).

The app checks every hour, and sends the digest once per month on or after the chosen day. If
sending fails, it retries every 6 hours and records the error in the audit log.

**Send this month's digest now** sends an extra copy immediately. The scheduled digest still
goes out as normal.

### Certificate discovery

Discovery finds certificates that nobody has added to the inventory yet.

1. Under **Certificate discovery**, list the hosts to check, one per line. Any of these forms
   works:
   ```
   www.example.com
   api.example.com:8443
   https://portal.example.com/login
   ```
   The port defaults to 443.
2. Save, then open the **Discovery** page and click **Scan now**. The app connects to each host
   over TLS and reads the certificate it presents. Self-signed and already-expired certificates
   are read too.
3. Each result shows whether it's already **in the inventory**. For ones that aren't, click
   **Add to inventory** to open a pre-filled form.
4. **Dismiss** hides a result you don't want to track, such as a third-party service. It comes
   back automatically if that host's certificate changes.

To scan automatically, turn **Automatic scanning** on and choose how often (in hours).

> The server running Cert Dashboard needs network access to the hosts you list. Hosts it can't
> reach are shown as *Unreachable*, together with the reason.

### CSR tool integration

If your organization has a tool for generating certificate signing requests (CSRs), you can link
it to the app so the **CSR** button on each certificate opens it with the details filled in.

Enter the tool's URL in **CSR tool URL template**, using any of these placeholders:

```
{commonName} {sans} {organization} {orgUnit} {country} {environment} {certName}
```

Example:

```
https://csr-tool.internal/new?cn={commonName}&san={sans}&o={organization}&ou={orgUnit}&c={country}
```

The URL must start with `https://` or `http://`.

### Audit log

The **Audit log** page lists every event:
- certificate changes and imports
- sign-ins, sign-outs and failed sign-in attempts
- password changes and resets
- settings changes, including which values changed
- user changes
- email sends
- discovery scans

Use the filter to narrow it by type. Entries can't be edited or deleted from the app.

---

## 6. Running it for your team

### Where to run it

Run the app on an always-on machine that your team can reach, such as a small internal server
or VM. Team members then open `http://<server-name>:3000` in their browser. Everyone shares the
same inventory, and each person signs in with their own account.

### Keep it running and start it at boot

The app has to keep running in the background. Pick one of these options.

**Option A: PM2 (Windows, macOS or Linux).**

Install PM2 globally:

```bash
npm install -g pm2
```

Start the app under PM2:

```bash
pm2 start server/index.js --name cert-dashboard
```

Save the process list so PM2 restores it:

```bash
pm2 save
```

Useful commands: `pm2 status`, `pm2 logs cert-dashboard`, `pm2 restart cert-dashboard`.
On Linux, `pm2 startup` configures start-at-boot. On Windows, use the `pm2-windows-startup` package
or Option B.

**Option B: Windows service with NSSM.**

Download NSSM from https://nssm.cc, then run:

```powershell
nssm install CertDashboard "C:\Program Files\nodejs\node.exe" "server\index.js"
```

In the NSSM window, set **Startup directory** to the project folder, then start the service
from *Services*.

**Option C: Linux systemd.**

Create `/etc/systemd/system/cert-dashboard.service`:

```ini
[Unit]
Description=Cert Dashboard
After=network.target

[Service]
WorkingDirectory=/opt/cert-dashboard
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
User=certdash
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

Then enable and start it:

```bash
sudo systemctl enable --now cert-dashboard
```

### Use HTTPS

Passwords are sent when people sign in, so for anything beyond a single machine, put the app
behind HTTPS. The usual setup is a reverse proxy (IIS, nginx, Apache or a load balancer) that
handles TLS and forwards requests to `http://localhost:3000`.

When the app is behind HTTPS, start it with `COOKIE_SECURE=true` so the sign-in cookie is only
ever sent over encrypted connections.

PowerShell:

```powershell
$env:COOKIE_SECURE = "true"; npm start
```

Linux (or add `Environment=COOKIE_SECURE=true` to the systemd unit above):

```bash
COOKIE_SECURE=true npm start
```

### Security behavior worth knowing

- Sign-in is locked for **15 minutes** after **5 failed attempts** for the same username.
- Sign-in sessions last **12 hours from the last activity**, and survive app restarts.
- Users on a temporary password (new accounts and password resets) can't do anything until
  they set their own password.
- Deleting a user or changing their role takes effect on their very next request.

---

## 7. Backup and restore

All data lives in the **`data/`** folder:

| File | Contents |
|---|---|
| `cert-dashboard.db` | Certificates, users, settings, audit log and sign-in sessions |
| `session-secret.txt` | Key used to sign sign-in cookies (created automatically) |

**Back up:** stop the app, copy the whole `data/` folder somewhere safe, then start the app
again. Schedule this daily.

**Restore:** stop the app, replace the `data/` folder with your backup, then start the app
again.

> `data/` contains password hashes and your SMTP password. Store backups somewhere only
> administrators can read.

---

## 8. Troubleshooting

**`No such built-in module: node:sqlite` or `ERR_UNKNOWN_BUILTIN_MODULE` on start-up**
Your Node.js is older than 22.5. Upgrade Node.js (see [Requirements](#1-requirements)).

**`EADDRINUSE: address already in use :::3000`**
Something else, possibly another copy of this app, is already using port 3000. Stop the other
program, or start on a different port (see [Using a different port](#using-a-different-port)).

**"Too many failed sign-in attempts"**
Wait 15 minutes, or ask an admin to reset the password.

**The only admin has forgotten their password**
Stop the app. Open a terminal in the project folder and run the command below, replacing
`NEW-TEMP-PASSWORD` with a temporary password of your choice:

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const b=require('bcryptjs');const h=b.hashSync('NEW-TEMP-PASSWORD',10);const db=new DatabaseSync('data/cert-dashboard.db');const r=db.prepare('UPDATE users SET password_hash=?, must_change_password=1 WHERE username=?').run(h,'admin');console.log(r.changes?'Password reset.':'User not found.')"
```

Start the app again and sign in with the temporary password; you'll be asked to set a new one.
Replace `'admin'` in the command if the admin account has a different username.

**Test email fails with "Invalid login"**
The SMTP username or password is wrong, or your provider needs an app password. Microsoft 365
tenants may also need SMTP AUTH enabled for the mailbox.

**Test email fails with a timeout**
The server can't reach the SMTP host on that port. Check the host and port, and any firewall
between them.

**CSV import says "expiry_date must be a real date"**
The date isn't year-first, or it doesn't exist (for example 31 February). Use `YYYY-MM-DD`. See
the Excel tip in [Importing and exporting](#importing-and-exporting-csv).

**Discovery shows a host as "Unreachable"**
The server running the app can't open a TLS connection to that host and port. The reason is
shown under *Unreachable*, for example a DNS lookup failure (`ENOTFOUND`) or a timeout.

**Everything looks unstyled or out of date after an upgrade**
Hard-refresh the browser (`Ctrl + F5`, or `Cmd + Shift + R` on a Mac).

---

## 9. Reference

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port the app listens on |
| `COOKIE_SECURE` | `false` | Set to `true` when serving over HTTPS |

### Limits

| Item | Limit |
|---|---|
| Uploaded file size (CSV or certificate) | 2 MB |
| Password length | at least 8 characters |
| Alert thresholds | 1–3650 days, in increasing order |
| Digest send day | 1–28 |
| Discovery interval | 1–720 hours |

### Project structure

```
cert-dashboard/
├── server/                 Backend (Node.js + Express)
│   ├── index.js            App entry point: sessions, routes, security headers
│   ├── db.js               Database schema and first-run setup
│   ├── routes/             API endpoints (certificates, users, settings, audit, discovery, notifications)
│   ├── middleware/auth.js  Sign-in and role checks
│   ├── scheduler.js        Hourly job for email digests and discovery scans
│   ├── mailer.js           Email digest
│   ├── discovery.js        TLS host scanning
│   └── certParser.js       Reads certificate files
├── public/                 Frontend (HTML, CSS, JavaScript; no build step)
│   ├── index.html          Main app
│   ├── login.html          Sign-in page
│   ├── css/style.css
│   └── js/app.js, js/login.js
├── data/                   Created on first run; holds all data (back this up)
├── sample-certificates.csv Example CSV for importing
└── package.json
```
