function pad(n) {
  return String(n).padStart(2, '0');
}

function localDateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localMonthKey(d = new Date()) {
  return localDateKey(d).slice(0, 7);
}

// Accepts YYYY-MM-DD or YYYY/M/D and returns a zero-padded YYYY-MM-DD, or null if
// the value isn't a real calendar date (e.g. 2026-02-31).
function normalizeDate(value) {
  if (value === undefined || value === null) return null;
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(String(value).trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

module.exports = { localDateKey, localMonthKey, normalizeDate };
