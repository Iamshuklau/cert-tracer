const db = require('./db');

const DEFAULT_THRESHOLDS = { critical: 7, warning: 30, upcoming: 90 };

function getThresholds() {
  const rows = db.prepare(
    `SELECT key, value FROM settings WHERE key IN ('threshold_critical_days','threshold_warning_days','threshold_upcoming_days')`
  ).all();
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const critical = parseInt(map.threshold_critical_days, 10);
  const warning = parseInt(map.threshold_warning_days, 10);
  const upcoming = parseInt(map.threshold_upcoming_days, 10);
  return {
    critical: Number.isFinite(critical) && critical > 0 ? critical : DEFAULT_THRESHOLDS.critical,
    warning: Number.isFinite(warning) && warning > 0 ? warning : DEFAULT_THRESHOLDS.warning,
    upcoming: Number.isFinite(upcoming) && upcoming > 0 ? upcoming : DEFAULT_THRESHOLDS.upcoming
  };
}

function daysUntil(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + 'T00:00:00');
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

function statusFor(dateStr, thresholds = DEFAULT_THRESHOLDS) {
  const days = daysUntil(dateStr);
  if (days < 0) return 'expired';
  if (days <= thresholds.critical) return 'critical';
  if (days <= thresholds.warning) return 'warning';
  if (days <= thresholds.upcoming) return 'upcoming';
  return 'healthy';
}

function annotate(cert, thresholds = DEFAULT_THRESHOLDS) {
  const daysLeft = daysUntil(cert.expiry_date);
  return { ...cert, days_left: daysLeft, status: statusFor(cert.expiry_date, thresholds) };
}

function monthKeyOf(dateStr) {
  return dateStr ? dateStr.slice(0, 7) : '';
}

module.exports = { daysUntil, statusFor, annotate, monthKeyOf, getThresholds, DEFAULT_THRESHOLDS };
