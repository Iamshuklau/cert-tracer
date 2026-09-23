const express = require('express');
const db = require('../db');
const { runDiscoveryScan, buildMatcher } = require('../discovery');
const { statusFor, daysUntil, getThresholds } = require('../status');
const { logEvent } = require('../audit');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/results', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM discovered_certs WHERE ignored = 0 ORDER BY (valid_to = '') ASC, valid_to ASC, host ASC`
  ).all();

  // Tracked status is resolved against the live certificate list, not the value saved at
  // scan time, so adding or deleting a certificate is reflected immediately.
  const match = buildMatcher();
  const thresholds = getThresholds();
  res.json(rows.map((r) => {
    const tracked = r.error ? null : match(r.common_name, r.host);
    return {
      ...r,
      matched_certificate_id: tracked ? tracked.id : null,
      matched_certificate_name: tracked ? tracked.name : null,
      days_left: r.valid_to ? daysUntil(r.valid_to) : null,
      status: r.valid_to ? statusFor(r.valid_to, thresholds) : null
    };
  }));
});

router.post('/scan-now', requireAdmin, async (req, res, next) => {
  try {
    const result = await runDiscoveryScan('manual');
    logEvent({ entityType: 'discovery', action: 'manual_scan', details: result, user: req.session.user });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/results/:id/dismiss', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM discovered_certs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Result not found' });
  db.prepare('UPDATE discovered_certs SET ignored = 1 WHERE id = ?').run(existing.id);
  logEvent({
    entityType: 'discovery', action: 'dismiss_result',
    details: { host: existing.host, port: existing.port }, user: req.session.user
  });
  res.json({ ok: true });
});

module.exports = router;
