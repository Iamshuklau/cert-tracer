const { X509Certificate } = require('node:crypto');

function parseFieldMap(str) {
  const map = {};
  (str || '').split('\n').forEach((line) => {
    const idx = line.indexOf('=');
    if (idx === -1) return;
    map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  });
  return map;
}

function parseSans(subjectAltName) {
  if (!subjectAltName) return '';
  return subjectAltName
    .split(',')
    .map((s) => s.trim().replace(/^DNS:|^IP Address:|^email:/, ''))
    .join(', ');
}

function toIsoDate(str) {
  if (!str) return '';
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function parseCertificateBuffer(buffer) {
  const cert = new X509Certificate(buffer);
  const subject = parseFieldMap(cert.subject);
  const issuer = parseFieldMap(cert.issuer);

  return {
    common_name: subject.CN || '',
    sans: parseSans(cert.subjectAltName),
    issuer: issuer.CN || issuer.O || '',
    organization: subject.O || '',
    org_unit: subject.OU || '',
    country: subject.C || '',
    issue_date: toIsoDate(cert.validFrom),
    expiry_date: toIsoDate(cert.validTo),
    serial_number: cert.serialNumber || '',
    fingerprint: cert.fingerprint256 || ''
  };
}

module.exports = { parseCertificateBuffer };
