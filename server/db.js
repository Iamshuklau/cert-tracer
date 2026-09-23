const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'cert-dashboard.db'));
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','editor')),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  common_name TEXT NOT NULL,
  sans TEXT DEFAULT '',
  issuer TEXT DEFAULT '',
  cert_type TEXT NOT NULL DEFAULT 'TLS/SSL',
  environment TEXT NOT NULL DEFAULT 'Production',
  owner_team TEXT DEFAULT '',
  organization TEXT DEFAULT '',
  org_unit TEXT DEFAULT '',
  country TEXT DEFAULT '',
  issue_date TEXT,
  expiry_date TEXT NOT NULL,
  ticket_number TEXT DEFAULT '',
  workflow_status TEXT NOT NULL DEFAULT 'not_started',
  source TEXT NOT NULL DEFAULT 'manual',
  notes TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_by_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_by_name TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS discovered_certs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 443,
  common_name TEXT DEFAULT '',
  sans TEXT DEFAULT '',
  issuer TEXT DEFAULT '',
  valid_from TEXT DEFAULT '',
  valid_to TEXT DEFAULT '',
  error TEXT,
  matched_certificate_id INTEGER REFERENCES certificates(id),
  ignored INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  entity_label TEXT,
  action TEXT NOT NULL,
  details TEXT,
  user_id INTEGER,
  username TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_certificates_expiry ON certificates(expiry_date);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_discovered_host ON discovered_certs(host, port);
`);

function migrate() {
  const columns = db.prepare('PRAGMA table_info(certificates)').all().map((c) => c.name);
  if (!columns.includes('ticket_number')) {
    db.exec(`ALTER TABLE certificates ADD COLUMN ticket_number TEXT DEFAULT ''`);
  }
  if (!columns.includes('workflow_status')) {
    db.exec(`ALTER TABLE certificates ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'not_started'`);
  }
  if (!columns.includes('source')) {
    db.exec(`ALTER TABLE certificates ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`);
  }
}

function seedDefaultAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;

  const password = 'try12@';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(
    `INSERT INTO users (username, password_hash, display_name, role, must_change_password)
     VALUES (?, ?, ?, 'admin', 1)`
  ).run('admin', hash, 'Administrator');

  const credFile = path.join(DATA_DIR, 'FIRST_RUN_ADMIN_CREDENTIALS.txt');
  fs.writeFileSync(
    credFile,
    `Cert Dashboard - first run admin account\n` +
    `Username: admin\n` +
    `Password: ${password}\n\n` +
    `You will be required to change this password on first login.\n` +
    `Delete this file once you have logged in and changed the password.\n`
  );

  console.log('========================================================');
  console.log(' Created default admin account');
  console.log(' Username: admin');
  console.log(` Password: ${password}`);
  console.log(` (also saved to data/FIRST_RUN_ADMIN_CREDENTIALS.txt)`);
  console.log('========================================================');
}

function seedDefaultSettings() {
  const defaults = {
    org_name: 'My Organization',
    csr_tool_url: '',
    csr_tool_label: 'CSR Generator',
    smtp_host: '',
    smtp_port: '587',
    smtp_secure: 'false',
    smtp_user: '',
    smtp_pass: '',
    smtp_from: '',
    notify_recipients: '',
    email_enabled: 'false',
    email_send_day: '1',
    last_monthly_email_sent: '',
    threshold_critical_days: '7',
    threshold_warning_days: '30',
    threshold_upcoming_days: '90',
    discovery_targets: '',
    discovery_enabled: 'false',
    discovery_interval_hours: '24',
    last_discovery_scan_at: ''
  };
  const existing = db.prepare('SELECT key FROM settings').all().map((r) => r.key);
  for (const [key, value] of Object.entries(defaults)) {
    if (!existing.includes(key)) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
    }
  }
}

migrate();
seedDefaultAdmin();
seedDefaultSettings();

module.exports = db;
