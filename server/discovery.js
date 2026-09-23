const tls = require('node:tls');
const net = require('node:net');
const db = require('./db');
const { logEvent } = require('./audit');

const SCAN_CONCURRENCY = 5;

// Accepts "host", "host:port", "https://host:port/path", "[::1]:8443" and bare IPv6.
function parseTarget(line) {
  let s = line.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  s = s.split(/[/?#]/)[0];
  if (!s) return null;

  let host = s;
  let port = 443;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (bracketed) {
    host = bracketed[1];
    if (bracketed[2]) port = Number(bracketed[2]);
  } else if (net.isIPv6(s)) {
    host = s;
  } else {
    const idx = s.lastIndexOf(':');
    if (idx !== -1) {
      host = s.slice(0, idx);
      port = Number(s.slice(idx + 1));
    }
  }
  host = host.trim().toLowerCase();
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

function parseTargets(raw) {
  const seen = new Set();
  const targets = [];
  for (const line of (raw || '').split(/\r?\n/)) {
    const t = parseTarget(line);
    if (!t) continue;
    const key = `${t.host}:${t.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(t);
  }
  return targets;
}

function toIsoDate(str) {
  if (!str) return '';
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function firstValue(v) {
  return Array.isArray(v) ? v[0] : v;
}

function scanHost(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let socket;
    try {
      // SNI must not be an IP address.
      const servername = net.isIP(host) ? undefined : host;
      socket = tls.connect({ host, port, servername, rejectUnauthorized: false, timeout: timeoutMs });
    } catch (err) {
      finish({ host, port, error: err.message });
      return;
    }

    const hardTimeout = setTimeout(() => {
      socket.destroy();
      finish({ host, port, error: 'Connection timed out' });
    }, timeoutMs + 2000);

    socket.on('secureConnect', () => {
      clearTimeout(hardTimeout);
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.subject) {
        finish({ host, port, error: 'No certificate returned by host' });
        return;
      }
      const sans = cert.subjectaltname
        ? cert.subjectaltname.split(',').map((s) => s.trim().replace(/^DNS:|^IP Address:/, '')).join(', ')
        : '';
      finish({
        host, port,
        common_name: firstValue(cert.subject.CN) || '',
        sans,
        issuer: (cert.issuer && (firstValue(cert.issuer.CN) || firstValue(cert.issuer.O))) || '',
        valid_from: toIsoDate(cert.valid_from),
        valid_to: toIsoDate(cert.valid_to),
        error: null
      });
    });
    socket.on('timeout', () => { clearTimeout(hardTimeout); socket.destroy(); finish({ host, port, error: 'Connection timed out' }); });
    socket.on('error', (err) => { clearTimeout(hardTimeout); finish({ host, port, error: err.message }); });
  });
}

function namesOf(value) {
  return String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function nameMatches(pattern, name) {
  if (pattern === name) return true;
  // "*.example.com" covers exactly one extra label, e.g. api.example.com but not a.b.example.com.
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return name.endsWith(suffix) && !name.slice(0, -suffix.length).includes('.');
  }
  return false;
}

// Returns a function that finds which tracked certificate (if any) a scan result corresponds to.
function buildMatcher() {
  const certs = db.prepare('SELECT id, name, common_name, sans FROM certificates').all()
    .map((c) => ({ id: c.id, name: c.name, cn: String(c.common_name || '').toLowerCase(), all: [String(c.common_name || '').toLowerCase(), ...namesOf(c.sans)].filter(Boolean) }));

  return (commonName, host) => {
    const cn = String(commonName || '').toLowerCase();
    const h = String(host || '').toLowerCase();
    if (cn) {
      const exact = certs.find((c) => c.cn === cn);
      if (exact) return exact;
    }
    return certs.find((c) => c.all.some((p) => (cn && nameMatches(p, cn)) || (h && nameMatches(p, h)))) || null;
  };
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

let runningScan = null;

function isScanRunning() {
  return runningScan !== null;
}

async function doScan(trigger) {
  const settingsRows = db.prepare('SELECT key, value FROM settings').all();
  const settings = Object.fromEntries(settingsRows.map((r) => [r.key, r.value]));
  const targets = parseTargets(settings.discovery_targets);

  const results = await mapWithConcurrency(targets, SCAN_CONCURRENCY, (t) => scanHost(t.host, t.port));
  const match = buildMatcher();

  let matched = 0;
  let errors = 0;

  for (const result of results) {
    if (result.error) errors++;
    const tracked = result.error ? null : match(result.common_name, result.host);
    const matchedCertId = tracked ? tracked.id : null;
    if (matchedCertId) matched++;

    const existing = db.prepare('SELECT * FROM discovered_certs WHERE host = ? AND port = ?').get(result.host, result.port);
    if (existing) {
      // A dismissed result stays hidden only while nothing about it has changed.
      // If the certificate data or its tracked-match status differs from what was
      // dismissed, resurface it — dismiss is a snooze, not a permanent mute.
      const changed = existing.ignored === 1 && (
        existing.common_name !== (result.common_name || '') ||
        existing.valid_to !== (result.valid_to || '') ||
        existing.matched_certificate_id !== matchedCertId
      );
      db.prepare(
        `UPDATE discovered_certs
         SET common_name = ?, sans = ?, issuer = ?, valid_from = ?, valid_to = ?, error = ?, matched_certificate_id = ?,
             ignored = CASE WHEN ? THEN 0 ELSE ignored END, last_checked_at = datetime('now')
         WHERE id = ?`
      ).run(
        result.common_name || '', result.sans || '', result.issuer || '',
        result.valid_from || '', result.valid_to || '', result.error, matchedCertId, changed ? 1 : 0, existing.id
      );
    } else {
      db.prepare(
        `INSERT INTO discovered_certs
          (host, port, common_name, sans, issuer, valid_from, valid_to, error, matched_certificate_id, first_seen_at, last_checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      ).run(
        result.host, result.port, result.common_name || '', result.sans || '', result.issuer || '',
        result.valid_from || '', result.valid_to || '', result.error, matchedCertId
      );
    }
  }

  db.prepare(`UPDATE settings SET value = ? WHERE key = 'last_discovery_scan_at'`).run(new Date().toISOString());
  const summary = { scanned: results.length, matched, errors };
  logEvent({ entityType: 'discovery', action: 'scan_completed', details: { trigger, targetCount: targets.length, ...summary } });
  return summary;
}

// Overlapping requests (a manual "Scan Now" during a scheduled scan) share the in-flight scan.
function runDiscoveryScan(trigger = 'scheduled') {
  if (!runningScan) {
    runningScan = doScan(trigger).finally(() => { runningScan = null; });
  }
  return runningScan;
}

module.exports = { runDiscoveryScan, isScanRunning, scanHost, parseTargets, buildMatcher };
