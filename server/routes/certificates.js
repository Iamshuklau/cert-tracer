const express = require('express');
const multer = require('multer');
const db = require('../db');
const { transaction } = require('../tx');
const { annotate, getThresholds } = require('../status');
const { normalizeDate } = require('../dates');
const { logEvent } = require('../audit');
const { parseCsv, toCsv } = require('../csv');
const { parseCertificateBuffer } = require('../certParser');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const EDITABLE_FIELDS = [
  'name', 'common_name', 'sans', 'issuer', 'cert_type', 'environment',
  'owner_team', 'organization', 'org_unit', 'country', 'issue_date',
  'expiry_date', 'ticket_number', 'workflow_status', 'notes'
];

const WORKFLOW_STATES = ['not_started', 'ticket_raised', 'in_progress', 'renewed', 'verified'];
const STATUS_RANK = { expired: 0, critical: 1, warning: 2, upcoming: 3, healthy: 4 };
const WORKFLOW_RANK = Object.fromEntries(WORKFLOW_STATES.map((s, i) => [s, i]));
const MAX_FIELD_LENGTH = 1000;
const MAX_NOTES_LENGTH = 10000;

const CSV_COLUMNS = [...EDITABLE_FIELDS, 'status', 'days_left'];

// Trims every provided field and normalizes dates in place; returns a list of errors.
function cleanAndValidate(data, { partial = false } = {}) {
  const errors = [];
  for (const f of EDITABLE_FIELDS) {
    if (data[f] === undefined) continue;
    data[f] = data[f] === null ? '' : String(data[f]).trim();
    const limit = f === 'notes' ? MAX_NOTES_LENGTH : MAX_FIELD_LENGTH;
    if (data[f].length > limit) errors.push(`${f} must be at most ${limit} characters`);
  }

  if (!partial || data.name !== undefined) {
    if (!data.name) errors.push('name is required');
  }
  if (!partial || data.common_name !== undefined) {
    if (!data.common_name) errors.push('common_name is required');
  }
  if (!partial || data.expiry_date !== undefined) {
    const normalized = normalizeDate(data.expiry_date);
    if (!normalized) errors.push('expiry_date must be a real date in YYYY-MM-DD format');
    else data.expiry_date = normalized;
  }
  if (data.issue_date) {
    const normalized = normalizeDate(data.issue_date);
    if (!normalized) errors.push('issue_date must be a real date in YYYY-MM-DD format');
    else data.issue_date = normalized;
  }
  if (data.workflow_status && !WORKFLOW_STATES.includes(data.workflow_status)) {
    errors.push(`workflow_status must be one of: ${WORKFLOW_STATES.join(', ')}`);
  }
  return errors;
}

function checkDateOrder(issueDate, expiryDate) {
  if (issueDate && expiryDate && issueDate > expiryDate) return 'issue_date cannot be after expiry_date';
  return null;
}

function sortValue(row, key) {
  if (key === 'status') return STATUS_RANK[row.status] ?? 99;
  if (key === 'workflow_status') return WORKFLOW_RANK[row.workflow_status] ?? 99;
  return row[key];
}

function compareRows(a, b, key, dir) {
  const av = sortValue(a, key);
  const bv = sortValue(b, key);
  const aEmpty = av === null || av === undefined || av === '';
  const bEmpty = bv === null || bv === undefined || bv === '';
  // Blank values always sink to the bottom, whichever direction is chosen.
  if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
  let cmp = 0;
  if (!aEmpty) {
    cmp = typeof av === 'number' && typeof bv === 'number'
      ? av - bv
      : String(av).localeCompare(String(bv), undefined, { sensitivity: 'base', numeric: true });
  }
  if (cmp !== 0) return cmp * dir;
  return (a.days_left - b.days_left) || (a.id - b.id);
}

function allAnnotated() {
  const thresholds = getThresholds();
  return db.prepare('SELECT * FROM certificates').all().map((c) => annotate(c, thresholds));
}

router.get('/', requireAuth, (req, res) => {
  const { status, cert_type, environment, owner_team, workflow_status, search, sortBy, sortDir } = req.query;
  let rows = allAnnotated();

  if (status) rows = rows.filter((r) => r.status === status);
  if (cert_type) rows = rows.filter((r) => r.cert_type === cert_type);
  if (environment) rows = rows.filter((r) => r.environment === environment);
  if (owner_team) rows = rows.filter((r) => r.owner_team === owner_team);
  if (workflow_status) rows = rows.filter((r) => r.workflow_status === workflow_status);
  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter((r) =>
      [r.name, r.common_name, r.sans, r.issuer, r.owner_team, r.notes, r.ticket_number]
        .some((v) => (v || '').toLowerCase().includes(q))
    );
  }

  const sortKey = sortBy && [...EDITABLE_FIELDS, 'days_left', 'status'].includes(sortBy) ? sortBy : 'days_left';
  const dir = sortDir === 'desc' ? -1 : 1;
  rows.sort((a, b) => compareRows(a, b, sortKey, dir));

  res.json(rows);
});

router.get('/export.csv', requireAuth, (req, res) => {
  const rows = allAnnotated().sort((a, b) => compareRows(a, b, 'expiry_date', 1));
  const csv = toCsv(rows, CSV_COLUMNS);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="certificates-${new Date().toISOString().slice(0, 10)}.csv"`);
  // BOM so Excel opens non-ASCII text (names, notes) as UTF-8.
  res.send('﻿' + csv);
});

router.get('/dashboard-summary', requireAuth, (req, res) => {
  const rows = allAnnotated();
  const summary = { expired: 0, critical: 0, warning: 0, upcoming: 0, healthy: 0, total: rows.length };
  for (const r of rows) if (summary[r.status] !== undefined) summary[r.status]++;

  const urgent = rows
    .filter((r) => r.status === 'expired' || r.status === 'critical')
    .sort((a, b) => a.days_left - b.days_left)
    .slice(0, 10);

  // Filter dropdown options come from the full inventory, not the currently filtered view.
  const distinct = (key) => [...new Set(rows.map((r) => r[key]).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  res.json({ summary, urgent, facets: { cert_types: distinct('cert_type'), environments: distinct('environment') } });
});

router.get('/:id/history', requireAuth, (req, res) => {
  const cert = db.prepare('SELECT id, name FROM certificates WHERE id = ?').get(req.params.id);
  const rows = db.prepare(
    `SELECT * FROM audit_log WHERE entity_type = 'certificate' AND entity_id = ? ORDER BY created_at DESC, id DESC`
  ).all(req.params.id);
  res.json({
    certificate: cert || null,
    history: rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }))
  });
});

const INSERT_SQL = `INSERT INTO certificates
  (name, common_name, sans, issuer, cert_type, environment, owner_team, organization, org_unit, country, issue_date, expiry_date, ticket_number, workflow_status, source, notes, created_by, created_by_name, updated_by, updated_by_name)
  VALUES (@name, @common_name, @sans, @issuer, @cert_type, @environment, @owner_team, @organization, @org_unit, @country, @issue_date, @expiry_date, @ticket_number, @workflow_status, @source, @notes, @created_by, @created_by_name, @created_by, @created_by_name)`;

function withDefaults(data) {
  const out = {};
  for (const f of EDITABLE_FIELDS) out[f] = data[f] === undefined ? '' : data[f];
  if (!out.cert_type) out.cert_type = 'TLS/SSL';
  if (!out.environment) out.environment = 'Production';
  if (!out.workflow_status) out.workflow_status = 'not_started';
  return out;
}

router.post('/', requireAuth, (req, res) => {
  const input = {};
  for (const f of EDITABLE_FIELDS) input[f] = req.body[f];
  const errors = cleanAndValidate(input);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  const data = withDefaults(input);
  const orderError = checkDateOrder(data.issue_date, data.expiry_date);
  if (orderError) return res.status(400).json({ error: orderError });

  const source = req.body.source === 'discovered' ? 'discovered' : 'manual';
  const user = req.session.user;
  const info = db.prepare(INSERT_SQL).run({ ...data, source, created_by: user.id, created_by_name: user.displayName });
  const cert = db.prepare('SELECT * FROM certificates WHERE id = ?').get(info.lastInsertRowid);

  logEvent({
    entityType: 'certificate', entityId: cert.id, entityLabel: cert.name,
    action: 'create', details: { fields: data, source }, user
  });

  res.status(201).json(annotate(cert, getThresholds()));
});

router.put('/:id', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM certificates WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Certificate not found' });

  const input = {};
  for (const f of EDITABLE_FIELDS) if (req.body[f] !== undefined) input[f] = req.body[f];
  const errors = cleanAndValidate(input, { partial: true });
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  if (input.workflow_status === '') input.workflow_status = 'not_started';
  if (input.cert_type === '') input.cert_type = existing.cert_type;
  if (input.environment === '') input.environment = existing.environment;

  const user = req.session.user;
  const changes = {};
  const next = { ...existing };
  for (const [f, newVal] of Object.entries(input)) {
    if (newVal !== (existing[f] || '')) {
      changes[f] = { from: existing[f] || '', to: newVal };
      next[f] = newVal;
    }
  }

  const orderError = checkDateOrder(next.issue_date, next.expiry_date);
  if (orderError) return res.status(400).json({ error: orderError });

  if (Object.keys(changes).length === 0) {
    return res.json(annotate(existing, getThresholds()));
  }

  const setClause = EDITABLE_FIELDS.map((f) => `${f} = @${f}`).join(', ');
  db.prepare(
    `UPDATE certificates SET ${setClause}, updated_by = @updated_by, updated_by_name = @updated_by_name, updated_at = datetime('now') WHERE id = @id`
  ).run({
    ...Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, next[f] || ''])),
    updated_by: user.id, updated_by_name: user.displayName, id: existing.id
  });

  const updated = db.prepare('SELECT * FROM certificates WHERE id = ?').get(existing.id);

  logEvent({
    entityType: 'certificate', entityId: existing.id, entityLabel: updated.name,
    action: 'update', details: { changes }, user
  });

  res.json(annotate(updated, getThresholds()));
});

router.delete('/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM certificates WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Certificate not found' });

  // Discovery results may point at this certificate; clear that link so the FK doesn't block the delete.
  transaction(() => {
    db.prepare('UPDATE discovered_certs SET matched_certificate_id = NULL WHERE matched_certificate_id = ?').run(existing.id);
    db.prepare('DELETE FROM certificates WHERE id = ?').run(existing.id);
  });

  logEvent({
    entityType: 'certificate', entityId: existing.id, entityLabel: existing.name,
    action: 'delete', details: { deleted: existing }, user: req.session.user
  });

  res.json({ ok: true });
});

router.post('/import', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let records;
  try {
    records = parseCsv(req.file.buffer.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'Could not parse CSV file' });
  }
  if (records.length === 0) return res.status(400).json({ error: 'The CSV file has no data rows' });
  if (!Object.keys(records[0]).includes('expiry_date')) {
    return res.status(400).json({ error: 'CSV is missing the required "expiry_date" column (see sample-certificates.csv)' });
  }

  const user = req.session.user;
  const created = [];
  const failed = [];
  const skipped = [];
  const insertStmt = db.prepare(INSERT_SQL);
  const existingKeys = new Set(
    db.prepare('SELECT lower(common_name) AS cn, expiry_date FROM certificates').all().map((r) => `${r.cn}|${r.expiry_date}`)
  );

  transaction(() => {
    records.forEach((rec, idx) => {
      const rowNumber = idx + 2;
      const input = {};
      for (const f of EDITABLE_FIELDS) input[f] = rec[f] === undefined ? '' : rec[f];
      const errors = cleanAndValidate(input);
      const data = withDefaults(input);
      const orderError = errors.length ? null : checkDateOrder(data.issue_date, data.expiry_date);
      if (orderError) errors.push(orderError);
      if (errors.length) {
        failed.push({ row: rowNumber, errors });
        return;
      }

      const key = `${data.common_name.toLowerCase()}|${data.expiry_date}`;
      if (existingKeys.has(key)) {
        skipped.push({ row: rowNumber, reason: `${data.common_name} expiring ${data.expiry_date} already exists` });
        return;
      }
      existingKeys.add(key);

      const info = insertStmt.run({ ...data, source: 'manual', created_by: user.id, created_by_name: user.displayName });
      logEvent({
        entityType: 'certificate', entityId: Number(info.lastInsertRowid), entityLabel: data.name,
        action: 'create', details: { fields: data, source: 'csv_import' }, user
      });
      created.push(data.name);
    });
  });

  logEvent({
    entityType: 'certificate', action: 'bulk_import',
    details: { createdCount: created.length, failedCount: failed.length, skippedCount: skipped.length, fileName: req.file.originalname },
    user
  });

  res.json({ createdCount: created.length, failed, skipped });
});

router.post('/parse-file', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const parsed = parseCertificateBuffer(req.file.buffer);
    if (!parsed.common_name && !parsed.expiry_date) {
      return res.status(400).json({ error: 'Could not find certificate data in this file' });
    }
    res.json(parsed);
  } catch (err) {
    res.status(400).json({ error: 'Could not parse this file as an X.509 certificate (expected PEM/.crt/.pem/.cer)' });
  }
});

module.exports = router;
