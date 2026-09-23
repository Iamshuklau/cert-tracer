const nodemailer = require('nodemailer');
const db = require('./db');
const { annotate, monthKeyOf, getThresholds } = require('./status');

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function buildTransport(settings) {
  if (!settings.smtp_host) return null;
  return nodemailer.createTransport({
    host: settings.smtp_host,
    port: Number(settings.smtp_port) || 587,
    secure: settings.smtp_secure === 'true',
    auth: settings.smtp_user ? { user: settings.smtp_user, pass: settings.smtp_pass } : undefined,
    // Defaults are ~2 minutes, which leaves the admin UI hanging on a wrong host.
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000
  });
}

function recipientsFrom(settings) {
  return (settings.notify_recipients || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function certsForMonth(monthKey) {
  const thresholds = getThresholds();
  return db.prepare('SELECT * FROM certificates').all()
    .map((c) => annotate(c, thresholds))
    .filter((c) => monthKeyOf(c.expiry_date) === monthKey)
    .sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));
}

// Certificates that expired before this month and are still expired would otherwise never
// appear in a digest again once their own month has passed.
function overdueBefore(monthKey) {
  const thresholds = getThresholds();
  const monthStart = `${monthKey}-01`;
  return db.prepare('SELECT * FROM certificates WHERE expiry_date < ?').all(monthStart)
    .map((c) => annotate(c, thresholds))
    .filter((c) => c.status === 'expired')
    .sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));
}

function monthLabel(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const WORKFLOW_LABELS = {
  not_started: 'Not Started', ticket_raised: 'Ticket Raised', in_progress: 'In Progress',
  renewed: 'Renewed', verified: 'Verified'
};

function renderTable(certs) {
  const cell = 'padding:8px;border-bottom:1px solid #e2e6ec;';
  const rows = certs.map((c) => `
    <tr>
      <td style="${cell}">${escapeHtml(c.name)}</td>
      <td style="${cell}">${escapeHtml(c.common_name)}</td>
      <td style="${cell}">${escapeHtml(c.owner_team)}</td>
      <td style="${cell}">${escapeHtml(c.expiry_date)}</td>
      <td style="${cell}text-transform:capitalize;">${escapeHtml(c.status)}</td>
      <td style="${cell}">${escapeHtml(c.ticket_number)}</td>
      <td style="${cell}">${escapeHtml(WORKFLOW_LABELS[c.workflow_status] || c.workflow_status)}</td>
    </tr>`).join('');
  return `
    <table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:14px;">
      <thead>
        <tr style="background:#f4f6f9;text-align:left;">
          <th style="padding:8px;">Name</th>
          <th style="padding:8px;">Common Name</th>
          <th style="padding:8px;">Owner / Team</th>
          <th style="padding:8px;">Expiry Date</th>
          <th style="padding:8px;">Status</th>
          <th style="padding:8px;">Ticket #</th>
          <th style="padding:8px;">Renewal</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderDigestHtml(monthKey, certs, overdue, orgName) {
  const label = monthLabel(monthKey);
  const monthSection = certs.length
    ? renderTable(certs)
    : `<p style="font-family:Arial,sans-serif;">No certificates are expiring in ${label}.</p>`;
  const overdueSection = overdue.length ? `
      <h3 style="margin:24px 0 4px;color:#c62828;">Already expired and still outstanding (${overdue.length})</h3>
      ${renderTable(overdue)}` : '';

  return `
    <div style="font-family:Arial,sans-serif;">
      <h2 style="margin-bottom:4px;">${escapeHtml(orgName)} — Certificates expiring in ${label}</h2>
      <p style="color:#6b7684;margin-top:0;">${certs.length} certificate${certs.length === 1 ? '' : 's'} expiring this month.</p>
      ${monthSection}
      ${overdueSection}
    </div>`;
}

async function sendTestEmail(toAddress) {
  const settings = getSettings();
  const transport = buildTransport(settings);
  if (!transport) throw new Error('SMTP is not configured yet (set the SMTP host in Admin → Email Notifications)');

  await transport.sendMail({
    from: settings.smtp_from || settings.smtp_user,
    to: toAddress,
    subject: `${settings.org_name || 'Cert Dashboard'} — test email`,
    html: `<p>This is a test email from Cert Dashboard. If you received this, your SMTP settings are working.</p>`
  });
}

async function sendMonthlyDigest(monthKey) {
  const settings = getSettings();
  const transport = buildTransport(settings);
  if (!transport) throw new Error('SMTP is not configured yet (set the SMTP host in Admin → Email Notifications)');

  const recipients = recipientsFrom(settings);
  if (recipients.length === 0) throw new Error('No recipient email addresses are configured');

  const certs = certsForMonth(monthKey);
  const overdue = overdueBefore(monthKey);
  const overdueNote = overdue.length ? `, ${overdue.length} already expired` : '';
  await transport.sendMail({
    from: settings.smtp_from || settings.smtp_user,
    to: recipients.join(','),
    subject: `${settings.org_name || 'Cert Dashboard'} — ${certs.length} certificate(s) expiring in ${monthLabel(monthKey)}${overdueNote}`,
    html: renderDigestHtml(monthKey, certs, overdue, settings.org_name || 'Cert Dashboard')
  });

  return { count: certs.length, overdue: overdue.length, recipients };
}

module.exports = { getSettings, certsForMonth, monthLabel, sendTestEmail, sendMonthlyDigest };
