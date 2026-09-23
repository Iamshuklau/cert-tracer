const express = require('express');
const { logEvent } = require('../audit');
const { sendTestEmail, sendMonthlyDigest } = require('../mailer');
const { localMonthKey } = require('../dates');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
const EMAIL_RE = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;

router.post('/test', requireAdmin, async (req, res) => {
  const to = String((req.body && req.body.to) || '').trim();
  if (!EMAIL_RE.test(to)) return res.status(400).json({ error: 'Enter a valid recipient email address' });

  try {
    await sendTestEmail(to);
    logEvent({ entityType: 'notification', action: 'test_email_sent', details: { to }, user: req.session.user });
    res.json({ ok: true });
  } catch (err) {
    logEvent({ entityType: 'notification', action: 'test_email_failed', details: { to, error: err.message }, user: req.session.user });
    res.status(400).json({ error: err.message });
  }
});

// A manual send is an extra, out-of-band email: it deliberately does not mark the month as
// sent, so the scheduled automatic digest still goes out on its configured day.
router.post('/send-now', requireAdmin, async (req, res) => {
  const month = req.body && req.body.month ? String(req.body.month) : localMonthKey();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: 'month must be in YYYY-MM format' });

  try {
    const result = await sendMonthlyDigest(month);
    logEvent({
      entityType: 'notification', action: 'manual_email_sent',
      details: { month, count: result.count, overdue: result.overdue, recipients: result.recipients }, user: req.session.user
    });
    res.json(result);
  } catch (err) {
    logEvent({ entityType: 'notification', action: 'manual_email_failed', details: { month, error: err.message }, user: req.session.user });
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
