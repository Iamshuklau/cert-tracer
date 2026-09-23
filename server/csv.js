function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { rows.push(row); row = []; };

  const clean = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\n') {
      pushField();
      pushRow();
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { pushField(); pushRow(); }

  const filtered = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (filtered.length === 0) return [];
  // "Common Name" / "COMMON_NAME" / "common name" all map to common_name.
  const headers = filtered[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  return filtered.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = unescapeFormula((r[idx] ?? '').trim()); });
    return obj;
  });
}

const FORMULA_START = /^[=+\-@\t\r]/;

function csvEscape(value) {
  let str = value === null || value === undefined ? '' : String(value);
  // Text that starts like a formula would execute when opened in Excel/Sheets.
  if (typeof value === 'string' && FORMULA_START.test(str)) str = "'" + str;
  if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

function unescapeFormula(value) {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

function toCsv(rows, columns) {
  const header = columns.map(csvEscape).join(',');
  const lines = rows.map((row) => columns.map((col) => csvEscape(row[col])).join(','));
  return [header, ...lines].join('\n');
}

module.exports = { parseCsv, toCsv };
