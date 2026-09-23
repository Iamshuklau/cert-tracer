const db = require('./db');
const { getSettings, sendMonthlyDigest } = require('./mailer');
const { runDiscoveryScan, isScanRunning } = require('./discovery');
const { localMonthKey } = require('./dates');
const { logEvent } = require('./audit');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly
const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60 * 1000;

let lastEmailFailureAt = 0;

async function checkAndSend() {
  const settings = getSettings();
  if (settings.email_enabled !== 'true') return;

  const sendDay = Math.min(Math.max(parseInt(settings.email_send_day, 10) || 1, 1), 28);
  const today = new Date();
  const thisMonth = localMonthKey(today);

  if (today.getDate() < sendDay) return;
  if (settings.last_monthly_email_sent === thisMonth) return;
  if (Date.now() - lastEmailFailureAt < RETRY_AFTER_FAILURE_MS) return;

  try {
    const result = await sendMonthlyDigest(thisMonth);
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(thisMonth, 'last_monthly_email_sent');
    lastEmailFailureAt = 0;
    logEvent({
      entityType: 'notification', action: 'monthly_email_sent',
      details: { month: thisMonth, count: result.count, overdue: result.overdue, recipients: result.recipients }
    });
  } catch (err) {
    lastEmailFailureAt = Date.now();
    logEvent({
      entityType: 'notification', action: 'monthly_email_failed',
      details: { month: thisMonth, error: err.message, nextRetryInHours: RETRY_AFTER_FAILURE_MS / 3600000 }
    });
  }
}

async function checkAndScan() {
  const settings = getSettings();
  if (settings.discovery_enabled !== 'true') return;
  if (!settings.discovery_targets || !settings.discovery_targets.trim()) return;
  if (isScanRunning()) return;

  const intervalHours = Math.max(parseInt(settings.discovery_interval_hours, 10) || 24, 1);
  const last = settings.last_discovery_scan_at ? new Date(settings.last_discovery_scan_at) : null;
  if (last && Date.now() - last.getTime() < intervalHours * 60 * 60 * 1000) return;

  try {
    await runDiscoveryScan('scheduled');
  } catch (err) {
    logEvent({ entityType: 'discovery', action: 'scan_failed', details: { error: err.message } });
  }
}

function tick() {
  checkAndSend().catch(() => {});
  checkAndScan().catch(() => {});
}

function startScheduler() {
  setTimeout(tick, 5000);
  setInterval(tick, CHECK_INTERVAL_MS);
}

module.exports = { startScheduler };
