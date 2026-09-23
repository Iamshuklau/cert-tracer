const express = require('express');
const db = require('../db');
const { transaction } = require('../tx');
const { logEvent } = require('../audit');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const PLAIN_KEYS = [
  'org_name', 'csr_tool_url', 'csr_tool_label',
  'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_from',
  'notify_recipients', 'email_enabled', 'email_send_day',
  'threshold_critical_days', 'threshold_warning_days', 'threshold_upcoming_days',
  'discovery_targets', 'discovery_enabled', 'discovery_interval_hours'
];

// Settings every signed-in user needs to render the dashboard; the rest is admin-only config.
const PUBLIC_KEYS = [
  'org_name', 'csr_tool_url', 'csr_tool_label',
  'threshold_critical_days', 'threshold_warning_days', 'threshold_upcoming_days'
];

const EMAIL_RE = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;

function parseIntStrict(value) {
  const str = String(value).trim();
  return /^\d+$/.test(str) ? Number(str) : NaN;
}

function intInRange(label, min, max) {
  return (value) => {
    const n = parseIntStrict(value);
    if (!Number.isInteger(n) || n < min || n > max) return { error: `${label} must be a whole number between ${min} and ${max}` };
    return { value: String(n) };
  };
}

function boolString(label) {
  return (value) => (value === 'true' || value === 'false' ? { value } : { error: `${label} must be true or false` });
}

const VALIDATORS = {
  org_name: (v) => {
    const s = String(v).trim();
    return s.length > 100 ? { error: 'Organization name must be at most 100 characters' } : { value: s };
  },
  csr_tool_label: (v) => ({ value: String(v).trim().slice(0, 60) }),
  csr_tool_url: (v) => {
    const s = String(v).trim();
    if (!s) return { value: '' };
    // Only http(s): anything else (javascript:, data:) would run in every user's browser.
    if (!/^https?:\/\/[^\s]+$/i.test(s)) return { error: 'CSR tool URL must start with http:// or https://' };
    return { value: s };
  },
  smtp_host: (v) => ({ value: String(v).trim() }),
  smtp_port: intInRange('SMTP port', 1, 65535),
  smtp_secure: boolString('Use TLS'),
  smtp_user: (v) => ({ value: String(v).trim() }),
  smtp_from: (v) => ({ value: String(v).trim() }),
  notify_recipients: (v) => {
    const list = String(v).split(',').map((s) => s.trim()).filter(Boolean);
    const bad = list.filter((e) => !EMAIL_RE.test(e));
    if (bad.length) return { error: `Invalid recipient email address: ${bad.join(', ')}` };
    return { value: list.join(', ') };
  },
  email_enabled: boolString('Send monthly digest automatically'),
  email_send_day: intInRange('Day of month to send', 1, 28),
  threshold_critical_days: intInRange('Critical threshold', 1, 3650),
  threshold_warning_days: intInRange('Warning threshold', 1, 3650),
  threshold_upcoming_days: intInRange('Upcoming threshold', 1, 3650),
  discovery_targets: (v) => ({ value: String(v).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join('\n') }),
  discovery_enabled: boolString('Scan automatically'),
  discovery_interval_hours: intInRange('Scan interval', 1, 720)
};

function readAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function adminSettings() {
  const { smtp_pass, ...rest } = readAllSettings();
  return { ...rest, smtp_pass_set: !!smtp_pass };
}

function publicSettings() {
  const all = readAllSettings();
  return Object.fromEntries(PUBLIC_KEYS.map((k) => [k, all[k]]));
}

router.get('/', requireAuth, (req, res) => {
  res.json(req.session.user.role === 'admin' ? adminSettings() : publicSettings());
});

router.put('/', requireAdmin, (req, res) => {
  const body = req.body || {};
  const updates = {};
  const errors = [];

  for (const key of PLAIN_KEYS) {
    if (body[key] === undefined || body[key] === null) continue;
    const result = VALIDATORS[key](body[key]);
    if (result.error) errors.push(result.error);
    else updates[key] = result.value;
  }
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  const current = readAllSettings();
  const critical = Number(updates.threshold_critical_days ?? current.threshold_critical_days);
  const warning = Number(updates.threshold_warning_days ?? current.threshold_warning_days);
  const upcoming = Number(updates.threshold_upcoming_days ?? current.threshold_upcoming_days);
  if (critical >= warning) return res.status(400).json({ error: 'Critical threshold must be less than the Warning threshold' });
  if (warning >= upcoming) return res.status(400).json({ error: 'Warning threshold must be less than the Upcoming threshold' });

  const changes = {};
  transaction(() => {
    for (const [key, value] of Object.entries(updates)) {
      if (current[key] === undefined) {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
        changes[key] = { from: null, to: value };
      } else if (current[key] !== value) {
        db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, key);
        changes[key] = { from: current[key], to: value };
      }
    }
    // smtp_pass is write-only: an empty/omitted value leaves the stored password untouched
    if (typeof body.smtp_pass === 'string' && body.smtp_pass) {
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(body.smtp_pass, 'smtp_pass');
      changes.smtp_pass = { updated: true };
    }
  });

  if (Object.keys(changes).length) {
    logEvent({ entityType: 'settings', action: 'update', details: { changes }, user: req.session.user });
  }

  res.json(adminSettings());
});

module.exports = router;
