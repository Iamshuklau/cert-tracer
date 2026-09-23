const state = {
  user: null,
  settings: {},
  certificates: [],
  facets: { cert_types: [], environments: [] },
  sortBy: 'expiry_date',
  sortDir: 'asc',
  auditPage: 1,
  auditPageSize: 50,
  auditTotal: 0,
  pendingConfirm: null,
  certRequestSeq: 0,
  forcedPasswordChange: false
};

/* ---------------- utils ---------------- */

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pad(n) { return String(n).padStart(2, '0'); }

function localMonthKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

// The server stores timestamps as SQLite UTC ("YYYY-MM-DD HH:MM:SS") or ISO strings;
// both must be shown in the viewer's local time.
function formatTimestamp(value) {
  if (!value) return '';
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function icon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function daysLabel(daysLeft) {
  if (daysLeft === null || daysLeft === undefined) return '';
  if (daysLeft < 0) return `${plural(Math.abs(daysLeft), 'day')} overdue`;
  if (daysLeft === 0) return 'Expires today';
  return `in ${plural(daysLeft, 'day')}`;
}

// Date on top, relative time underneath, coloured only when it needs attention.
function expiryCell(dateStr, daysLeft) {
  if (!dateStr) return '<span class="muted">—</span>';
  const cls = daysLeft < 0 ? 'overdue' : daysLeft <= Number(state.settings.threshold_critical_days || 7) ? 'due-soon' : '';
  return `<div class="cell-stack"><span class="cell-primary num">${escapeHtml(dateStr)}</span>` +
    `<span class="cell-secondary ${cls}">${daysLabel(daysLeft)}</span></div>`;
}

function titleCase(str) {
  return String(str || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function toast(message, type = '') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...options
  });
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('Not authenticated');
  }
  if (res.status === 403 && data && data.code === 'PASSWORD_CHANGE_REQUIRED') {
    openForcedPasswordModal();
    throw new Error(data.error);
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

// Disables the button while the request runs so a double-click can't submit twice.
async function withBusy(button, fn) {
  if (!button) return fn();
  if (button.disabled) return undefined;
  button.disabled = true;
  try {
    return await fn();
  } finally {
    button.disabled = false;
  }
}

function openModal(id) { document.getElementById(id).hidden = false; }
function closeModal(id) { document.getElementById(id).hidden = true; }

function confirmAction(title, text, onConfirm) {
  document.getElementById('confirm-modal-title').textContent = title;
  document.getElementById('confirm-modal-text').textContent = text;
  state.pendingConfirm = onConfirm;
  openModal('confirm-modal');
}

document.getElementById('confirm-modal-ok').addEventListener('click', () => {
  const fn = state.pendingConfirm;
  closeModal('confirm-modal');
  state.pendingConfirm = null;
  if (fn) fn();
});
document.getElementById('confirm-modal-cancel').addEventListener('click', () => {
  state.pendingConfirm = null;
  closeModal('confirm-modal');
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = [...document.querySelectorAll('.modal-backdrop')].filter((m) => !m.hidden);
  const top = open[open.length - 1];
  if (!top) return;
  if (top.id === 'password-modal' && state.forcedPasswordChange) return;
  if (top.id === 'confirm-modal') state.pendingConfirm = null;
  closeModal(top.id);
});

// Keeps a <select> showing a stored value even if it isn't one of the built-in options
// (e.g. "SSL" imported from CSV) so editing doesn't silently change it.
function setSelectValue(select, value, fallback) {
  const v = value || fallback;
  if (v && ![...select.options].some((o) => o.value === v)) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    opt.dataset.dynamic = 'true';
    select.appendChild(opt);
  }
  select.value = v;
}

function removeDynamicOptions(select) {
  select.querySelectorAll('option[data-dynamic]').forEach((o) => o.remove());
}

/* ---------------- bootstrap ---------------- */

async function bootstrap() {
  let me;
  try {
    me = await api('/api/auth/me');
  } catch {
    return; // api() already redirected
  }
  state.user = me.user;
  renderUserChrome();

  if (me.mustChangePassword) {
    openForcedPasswordModal();
    return;
  }

  try {
    await loadSettings();
    await refreshAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function renderUserChrome() {
  document.getElementById('current-user').textContent = state.user.displayName;
  document.getElementById('current-role').textContent = state.user.role === 'admin' ? 'Admin' : 'Editor';
  document.getElementById('current-avatar').textContent = initials(state.user.displayName);
  document.querySelectorAll('.admin-only').forEach((el) => (el.hidden = state.user.role !== 'admin'));
}

async function loadSettings() {
  state.settings = await api('/api/settings');
  const orgName = state.settings.org_name || 'Cert Dashboard';
  document.getElementById('org-name').textContent = state.settings.org_name || '';
  document.title = `${orgName} · Cert Dashboard`;
  document.getElementById('setting-org-name').value = state.settings.org_name || '';
  document.getElementById('setting-csr-label').value = state.settings.csr_tool_label || '';
  document.getElementById('setting-csr-url').value = state.settings.csr_tool_url || '';
  updateThresholdLabels();
}

function updateThresholdLabels() {
  const critical = Number(state.settings.threshold_critical_days || 7);
  const warning = Number(state.settings.threshold_warning_days || 30);
  const upcoming = Number(state.settings.threshold_upcoming_days || 90);
  document.getElementById('caption-critical').textContent = `Expires within ${plural(critical, 'day')}`;
  document.getElementById('caption-warning').textContent = `Expires in ${critical + 1}–${warning} days`;
  document.getElementById('caption-upcoming').textContent = `Expires in ${warning + 1}–${upcoming} days`;
  document.getElementById('caption-healthy').textContent = `More than ${upcoming} days left`;
}

async function refreshAll() {
  await Promise.all([loadSummary(), loadCertificates()]);
}

/* ---------------- dashboard ---------------- */

async function loadSummary() {
  const { summary, facets } = await api('/api/certificates/dashboard-summary');
  document.getElementById('count-total').textContent = summary.total;
  document.getElementById('count-expired').textContent = summary.expired;
  document.getElementById('count-critical').textContent = summary.critical;
  document.getElementById('count-warning').textContent = summary.warning;
  document.getElementById('count-upcoming').textContent = summary.upcoming;
  document.getElementById('count-healthy').textContent = summary.healthy;

  const banner = document.getElementById('urgent-banner');
  const urgentCount = summary.expired + summary.critical;
  state.urgentFilter = summary.expired > 0 ? 'expired' : 'critical';
  if (urgentCount > 0) {
    banner.hidden = false;
    const criticalDays = Number(state.settings.threshold_critical_days || 7);
    const parts = [];
    if (summary.expired) parts.push(`${plural(summary.expired, 'certificate')} ${summary.expired === 1 ? 'has' : 'have'} expired`);
    if (summary.critical) parts.push(`${plural(summary.critical, 'certificate')} ${summary.critical === 1 ? 'expires' : 'expire'} within ${plural(criticalDays, 'day')}`);
    document.getElementById('urgent-count-text').textContent = `${parts.join(' and ')}. Start renewal to avoid service disruption.`;
  } else {
    banner.hidden = true;
  }

  state.facets = facets || { cert_types: [], environments: [] };
  populateFilterOptions();
}

function buildQuery() {
  const params = new URLSearchParams();
  const status = document.getElementById('filter-status').value;
  const type = document.getElementById('filter-type').value;
  const env = document.getElementById('filter-environment').value;
  const workflow = document.getElementById('filter-workflow').value;
  const search = document.getElementById('search-input').value.trim();
  if (status) params.set('status', status);
  if (type) params.set('cert_type', type);
  if (env) params.set('environment', env);
  if (workflow) params.set('workflow_status', workflow);
  if (search) params.set('search', search);
  params.set('sortBy', state.sortBy);
  params.set('sortDir', state.sortDir);
  return params.toString();
}

async function loadCertificates() {
  // Only the latest request may render; an older, slower response must not overwrite it.
  const seq = ++state.certRequestSeq;
  const rows = await api(`/api/certificates?${buildQuery()}`);
  if (seq !== state.certRequestSeq) return;
  state.certificates = rows;
  renderTable(rows);
  updateSortIndicators();
  syncSummaryCardActive();
}

function reloadCertificates() {
  loadCertificates().catch((err) => toast(err.message, 'error'));
}

function syncSummaryCardActive() {
  const status = document.getElementById('filter-status').value;
  document.querySelectorAll('.summary-card').forEach((c) => c.classList.toggle('active', c.dataset.status === status));
}

// Options come from the whole inventory (not the filtered rows) so a selection never
// disappears from its own dropdown when a filter combination matches nothing.
function populateFilterOptions() {
  const fill = (select, allLabel, values) => {
    const current = select.value;
    const list = [...values];
    if (current && !list.includes(current)) list.push(current);
    select.innerHTML = `<option value="">${allLabel}</option>` +
      list.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    select.value = current;
  };
  fill(document.getElementById('filter-type'), 'All types', state.facets.cert_types || []);
  fill(document.getElementById('filter-environment'), 'All environments', state.facets.environments || []);
}

const WORKFLOW_LABELS = {
  not_started: 'Not started',
  ticket_raised: 'Ticket raised',
  in_progress: 'In progress',
  renewed: 'Renewed',
  verified: 'Verified'
};
const WORKFLOW_ORDER = Object.keys(WORKFLOW_LABELS);

// Renewal stage shown as a label over a 5-step progress track.
function workflowBadge(workflowStatus) {
  const key = WORKFLOW_LABELS[workflowStatus] ? workflowStatus : 'not_started';
  const reached = WORKFLOW_ORDER.indexOf(key) + 1;
  const steps = WORKFLOW_ORDER.map((_, i) => `<i class="${i < reached ? 'on' : ''}"></i>`).join('');
  return `<span class="stage ${key}" title="Renewal stage ${reached} of ${WORKFLOW_ORDER.length}">` +
    `<span class="stage-label">${escapeHtml(WORKFLOW_LABELS[key])}</span><span class="stage-track">${steps}</span></span>`;
}

// Status colour is never used alone: every badge carries an icon and a text label.
const STATUS_META = {
  expired: { label: 'Expired', icon: 'x-circle' },
  critical: { label: 'Critical', icon: 'alert-circle' },
  warning: { label: 'Warning', icon: 'alert' },
  upcoming: { label: 'Upcoming', icon: 'clock' },
  healthy: { label: 'Healthy', icon: 'check-circle' }
};

function statusPill(status) {
  const meta = STATUS_META[status];
  if (!meta) return '<span class="muted">—</span>';
  return `<span class="status-pill ${status}">${icon(meta.icon)}${meta.label}</span>`;
}

function certificateCell(r) {
  return `<div class="cell-stack cell-title"><span class="cell-primary">${escapeHtml(r.name)}</span>` +
    `<span class="cell-secondary">${escapeHtml(r.common_name)}</span></div>`;
}

function ticketCell(ticket) {
  return ticket ? `<span class="ticket-chip">${escapeHtml(ticket)}</span>` : '<span class="muted">—</span>';
}

function renderTable(rows) {
  const tbody = document.getElementById('cert-table-body');
  const emptyState = document.getElementById('empty-state');

  if (rows.length === 0) {
    tbody.innerHTML = '';
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  const isAdmin = state.user.role === 'admin';
  tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${certificateCell(r)}</td>
        <td>${expiryCell(r.expiry_date, r.days_left)}</td>
        <td>${statusPill(r.status)}</td>
        <td>${workflowBadge(r.workflow_status)}</td>
        <td>${ticketCell(r.ticket_number)}</td>
        <td><div class="cell-stack"><span class="cell-primary">${escapeHtml(r.environment)}</span><span class="cell-secondary">${escapeHtml(r.cert_type)}</span></div></td>
        <td>${r.owner_team ? escapeHtml(r.owner_team) : '<span class="muted">Unassigned</span>'}</td>
        <td>
          <div class="row-actions">
            <button data-action="edit" data-id="${r.id}" class="link-primary">Edit</button>
            <button data-action="csr" data-id="${r.id}" title="Open the CSR tool for this certificate">CSR</button>
            <button data-action="history" data-id="${r.id}">History</button>
            ${isAdmin ? `<button data-action="delete" data-id="${r.id}" class="danger">Delete</button>` : ''}
          </div>
        </td>
      </tr>`).join('');
}

function updateSortIndicators() {
  document.querySelectorAll('#cert-table thead th[data-sort]').forEach((th) => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.sort === state.sortBy) {
      th.classList.add(state.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  });
}

document.getElementById('cert-table-body').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const cert = state.certificates.find((c) => c.id === id);
  if (!cert) return;

  if (btn.dataset.action === 'edit') openCertModal(cert);
  if (btn.dataset.action === 'history') openHistoryModal(cert);
  if (btn.dataset.action === 'csr') openCsrModal(cert);
  if (btn.dataset.action === 'delete') {
    confirmAction('Delete this certificate?', `“${cert.name}” will be removed from the inventory. Its change history stays in the audit log.`, async () => {
      try {
        await api(`/api/certificates/${id}`, { method: 'DELETE' });
        toast('Certificate deleted', 'success');
        await refreshAll();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }
});

document.querySelectorAll('#cert-table thead th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.sortBy === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortBy = key;
      state.sortDir = 'asc';
    }
    reloadCertificates();
  });
});

document.getElementById('urgent-review').addEventListener('click', () => {
  document.getElementById('filter-status').value = state.urgentFilter || 'expired';
  reloadCertificates();
});

document.querySelectorAll('.summary-card').forEach((card) => {
  card.addEventListener('click', () => {
    document.getElementById('filter-status').value = card.dataset.status;
    reloadCertificates();
  });
});

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

document.getElementById('search-input').addEventListener('input', debounce(reloadCertificates, 250));
['filter-status', 'filter-type', 'filter-environment', 'filter-workflow'].forEach((id) => {
  document.getElementById(id).addEventListener('change', reloadCertificates);
});

/* ---------------- certificate modal ---------------- */

const certForm = document.getElementById('cert-form');

function openCertModal(cert, prefill) {
  document.getElementById('cert-form-error').hidden = true;
  certForm.reset();
  const typeSelect = document.getElementById('cert-type');
  const envSelect = document.getElementById('cert-environment');
  removeDynamicOptions(typeSelect);
  removeDynamicOptions(envSelect);
  document.getElementById('cert-file-input').value = '';
  document.getElementById('cert-file-status').textContent = '';
  const src = cert || prefill || {};
  document.getElementById('cert-modal-title').textContent = cert ? `Edit ${cert.name}` : prefill ? 'Add discovered certificate' : 'Add certificate';
  document.getElementById('cert-id').value = cert ? cert.id : '';
  document.getElementById('cert-source').value = prefill ? 'discovered' : 'manual';
  document.getElementById('cert-name').value = src.name || '';
  document.getElementById('cert-common-name').value = src.common_name || '';
  document.getElementById('cert-sans').value = src.sans || '';
  document.getElementById('cert-issuer').value = src.issuer || '';
  setSelectValue(typeSelect, src.cert_type, 'TLS/SSL');
  setSelectValue(envSelect, src.environment, 'Production');
  document.getElementById('cert-owner-team').value = src.owner_team || '';
  document.getElementById('cert-organization').value = src.organization || '';
  document.getElementById('cert-org-unit').value = src.org_unit || '';
  document.getElementById('cert-country').value = src.country || '';
  document.getElementById('cert-issue-date').value = src.issue_date || '';
  document.getElementById('cert-expiry-date').value = src.expiry_date || '';
  document.getElementById('cert-ticket-number').value = src.ticket_number || '';
  document.getElementById('cert-workflow-status').value = WORKFLOW_LABELS[src.workflow_status] ? src.workflow_status : 'not_started';
  document.getElementById('cert-notes').value = src.notes || '';
  openModal('cert-modal');
  document.getElementById('cert-name').focus();
}

document.getElementById('btn-add-cert').addEventListener('click', () => openCertModal(null));
document.getElementById('cert-modal-cancel').addEventListener('click', () => closeModal('cert-modal'));

document.getElementById('cert-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById('cert-file-status');
  statusEl.textContent = 'Parsing…';
  const formData = new FormData();
  formData.append('file', file);
  try {
    const parsed = await api('/api/certificates/parse-file', { method: 'POST', body: formData });
    const set = (id, value) => { if (value) document.getElementById(id).value = value; };
    set('cert-common-name', parsed.common_name);
    set('cert-sans', parsed.sans);
    set('cert-issuer', parsed.issuer);
    set('cert-organization', parsed.organization);
    set('cert-org-unit', parsed.org_unit);
    set('cert-country', parsed.country);
    set('cert-issue-date', parsed.issue_date);
    set('cert-expiry-date', parsed.expiry_date);
    if (!document.getElementById('cert-name').value) {
      document.getElementById('cert-name').value = parsed.common_name || '';
    }
    statusEl.textContent = 'Parsed — review the fields below and save.';
    toast('Certificate file parsed', 'success');
  } catch (err) {
    statusEl.textContent = '';
    toast(err.message, 'error');
  } finally {
    e.target.value = '';
  }
});

certForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('cert-form-error');
  errorEl.hidden = true;

  const id = document.getElementById('cert-id').value;
  const payload = {
    name: document.getElementById('cert-name').value.trim(),
    common_name: document.getElementById('cert-common-name').value.trim(),
    sans: document.getElementById('cert-sans').value.trim(),
    issuer: document.getElementById('cert-issuer').value.trim(),
    cert_type: document.getElementById('cert-type').value,
    environment: document.getElementById('cert-environment').value,
    owner_team: document.getElementById('cert-owner-team').value.trim(),
    organization: document.getElementById('cert-organization').value.trim(),
    org_unit: document.getElementById('cert-org-unit').value.trim(),
    country: document.getElementById('cert-country').value.trim(),
    issue_date: document.getElementById('cert-issue-date').value,
    expiry_date: document.getElementById('cert-expiry-date').value,
    ticket_number: document.getElementById('cert-ticket-number').value.trim(),
    workflow_status: document.getElementById('cert-workflow-status').value,
    notes: document.getElementById('cert-notes').value.trim()
  };
  if (payload.issue_date && payload.expiry_date && payload.issue_date > payload.expiry_date) {
    errorEl.textContent = 'Issue date cannot be after the expiry date';
    errorEl.hidden = false;
    return;
  }
  if (!id) payload.source = document.getElementById('cert-source').value;

  withBusy(document.getElementById('cert-modal-save'), async () => {
    try {
      if (id) {
        await api(`/api/certificates/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast('Certificate updated', 'success');
      } else {
        await api('/api/certificates', { method: 'POST', body: JSON.stringify(payload) });
        toast('Certificate added', 'success');
      }
      closeModal('cert-modal');
      await refreshAll();
      if (!document.getElementById('view-discovery').hidden) await loadDiscoveryResults();
      if (!document.getElementById('view-monthly').hidden) await loadMonthlyView();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
});

/* ---------------- history modal ---------------- */

const ACTION_LABELS = {
  create: 'Created',
  update: 'Updated',
  delete: 'Deleted',
  bulk_import: 'Imported from CSV',
  login: 'Signed in',
  logout: 'Signed out',
  login_failed: 'Sign-in failed',
  password_changed: 'Password changed',
  password_reset: 'Password reset',
  test_email_sent: 'Test email sent',
  test_email_failed: 'Test email failed',
  manual_email_sent: 'Digest sent manually',
  manual_email_failed: 'Manual digest failed',
  monthly_email_sent: 'Monthly digest sent',
  monthly_email_failed: 'Monthly digest failed',
  scan_completed: 'Scan completed',
  scan_failed: 'Scan failed',
  manual_scan: 'Scan started manually',
  dismiss_result: 'Result dismissed'
};

function actionLabel(action) {
  return ACTION_LABELS[action] || titleCase(action);
}

const ENTITY_LABELS = { certificate: 'Certificate', user: 'User', settings: 'Settings', auth: 'Sign-in', notification: 'Email', discovery: 'Discovery' };

async function openHistoryModal(cert) {
  document.getElementById('history-modal-title').textContent = `Change history · ${cert.name}`;
  const list = document.getElementById('history-list');
  list.innerHTML = '<p class="muted">Loading…</p>';
  openModal('history-modal');

  try {
    const { history } = await api(`/api/certificates/${cert.id}/history`);
    if (history.length === 0) {
      list.innerHTML = '<p class="muted">No changes have been recorded yet.</p>';
      return;
    }
    list.innerHTML = history.map((h) => `
      <div class="history-item">
        <div class="history-top">
          <span class="event-name">${escapeHtml(actionLabel(h.action))}</span>
          <span class="meta-text">${escapeHtml(h.username)} · ${escapeHtml(formatTimestamp(h.created_at))}</span>
        </div>
        ${h.details ? `<pre>${escapeHtml(JSON.stringify(h.details, null, 2))}</pre>` : ''}
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
  }
}

document.getElementById('history-modal-close').addEventListener('click', () => closeModal('history-modal'));

/* ---------------- CSR modal ---------------- */

function openCsrModal(cert) {
  const template = state.settings.csr_tool_url || '';
  const label = state.settings.csr_tool_label || 'CSR Generator';
  document.getElementById('csr-modal-title').textContent = label;
  const link = document.getElementById('csr-modal-open');
  const desc = document.getElementById('csr-modal-desc');

  // Only ever link to http(s); the server validates this too.
  if (!/^https?:\/\//i.test(template)) {
    desc.textContent = 'A CSR tool hasn’t been configured yet. An administrator can add one under Settings → Organization and CSR integration.';
    link.hidden = true;
    link.removeAttribute('href');
    openModal('csr-modal');
    return;
  }

  const placeholders = {
    '{commonName}': cert.common_name,
    '{sans}': cert.sans,
    '{organization}': cert.organization,
    '{orgUnit}': cert.org_unit,
    '{country}': cert.country,
    '{environment}': cert.environment,
    '{certName}': cert.name
  };
  let url = template;
  for (const [key, value] of Object.entries(placeholders)) {
    url = url.split(key).join(encodeURIComponent(value || ''));
  }

  desc.textContent = `${label} will open in a new tab with the details of “${cert.name}” (${cert.common_name}) filled in.`;
  link.hidden = false;
  link.href = url;
  openModal('csr-modal');
}

document.getElementById('csr-modal-close').addEventListener('click', () => closeModal('csr-modal'));
document.getElementById('csr-modal-open').addEventListener('click', () => closeModal('csr-modal'));

/* ---------------- import / export ---------------- */

document.getElementById('btn-export').addEventListener('click', () => {
  window.location.href = '/api/certificates/export.csv';
});

document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('import-file-input').click();
});

function showImportResult(result) {
  const skipped = result.skipped || [];
  const failed = result.failed || [];
  const lines = [`<div class="import-stat">
    <span><strong>${result.createdCount}</strong>imported</span>
    <span><strong>${skipped.length}</strong>skipped as duplicates</span>
    <span><strong>${failed.length}</strong>could not be imported</span>
  </div>`];
  if (failed.length) {
    lines.push('<h3>Rows that need fixing</h3><ul>' +
      failed.slice(0, 50).map((f) => `<li>Row ${f.row}: ${escapeHtml(f.errors.join('; '))}</li>`).join('') + '</ul>');
  }
  if (skipped.length) {
    lines.push('<h3>Already in the inventory</h3><ul>' +
      skipped.slice(0, 50).map((s) => `<li>Row ${s.row}: ${escapeHtml(s.reason)}</li>`).join('') + '</ul>');
  }
  document.getElementById('import-result-body').innerHTML = lines.join('');
  openModal('import-result-modal');
}

document.getElementById('import-result-close').addEventListener('click', () => closeModal('import-result-modal'));

document.getElementById('import-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  await withBusy(document.getElementById('btn-import'), async () => {
    try {
      const result = await api('/api/certificates/import', { method: 'POST', body: formData });
      if ((result.failed && result.failed.length) || (result.skipped && result.skipped.length)) {
        showImportResult(result);
      } else {
        toast(`Imported ${result.createdCount} certificate(s)`, 'success');
      }
      await refreshAll();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      e.target.value = '';
    }
  });
});

/* ---------------- navigation ---------------- */

async function refreshSettingsQuietly() {
  try {
    await loadSettings();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function showView(name) {
  ['dashboard', 'monthly', 'discovery', 'audit', 'admin'].forEach((v) => {
    document.getElementById(`view-${v}`).hidden = v !== name;
    document.getElementById(`nav-${v}`)?.classList.toggle('active', v === name);
  });
  try {
    if (name === 'dashboard') await refreshAll();
    if (name === 'monthly') await loadMonthlyView();
    if (name === 'discovery') { await refreshSettingsQuietly(); await loadDiscoveryResults(); }
    if (name === 'audit') await loadAuditLog();
    if (name === 'admin') {
      // Settings may have changed since page load (another admin, or the scheduler).
      await refreshSettingsQuietly();
      loadEmailSettings();
      loadThresholdSettings();
      loadDiscoverySettings();
      await loadUsers();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

document.getElementById('nav-dashboard').addEventListener('click', () => showView('dashboard'));
document.getElementById('nav-monthly').addEventListener('click', () => showView('monthly'));
document.getElementById('nav-discovery').addEventListener('click', () => showView('discovery'));
document.getElementById('nav-audit').addEventListener('click', () => showView('audit'));
document.getElementById('nav-admin').addEventListener('click', () => showView('admin'));

/* ---------------- monthly view ---------------- */

function monthKeyOf(dateStr) { return dateStr ? dateStr.slice(0, 7) : ''; }

function monthLabelOf(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

async function loadMonthlyView() {
  const rows = await api('/api/certificates?sortBy=expiry_date&sortDir=asc');
  const groups = new Map();
  for (const r of rows) {
    const key = monthKeyOf(r.expiry_date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const sortedKeys = [...groups.keys()].sort();
  const cardsEl = document.getElementById('month-cards');
  const currentMonth = localMonthKey();

  if (sortedKeys.length === 0) {
    cardsEl.innerHTML = '<p class="meta-text">No certificates in the inventory yet.</p>';
  } else {
    cardsEl.innerHTML = sortedKeys.map((key) => {
      const certs = groups.get(key);
      const urgentCount = certs.filter((c) => c.status === 'expired' || c.status === 'critical').length;
      const tone = key < currentMonth ? 'past' : key === currentMonth ? 'current' : 'future';
      return `
        <button class="month-card ${tone} ${urgentCount ? 'has-urgent' : ''}" data-month="${key}">
          <div class="month-card-label">${escapeHtml(monthLabelOf(key))}</div>
          <div class="month-card-count">${certs.length}</div>
          <div class="month-card-sub">${urgentCount > 0 ? `${icon('alert-circle')}${urgentCount} need${urgentCount === 1 ? 's' : ''} attention` : (certs.length === 1 ? 'certificate' : 'certificates')}</div>
        </button>`;
    }).join('');
  }

  cardsEl.querySelectorAll('.month-card').forEach((card) => {
    card.addEventListener('click', () => renderMonthTable(groups.get(card.dataset.month) || [], card.dataset.month));
  });

  const defaultKey = sortedKeys.includes(currentMonth) ? currentMonth : sortedKeys.find((k) => k >= currentMonth) || sortedKeys[sortedKeys.length - 1];
  renderMonthTable(defaultKey ? groups.get(defaultKey) : [], defaultKey);
}

function renderMonthTable(certs, monthKey) {
  document.querySelectorAll('.month-card').forEach((c) => c.classList.toggle('selected', c.dataset.month === monthKey));

  const tbody = document.getElementById('month-table-body');
  const emptyState = document.getElementById('month-empty-state');
  if (!certs || certs.length === 0) {
    tbody.innerHTML = '';
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  tbody.innerHTML = certs.map((r) => `
    <tr>
      <td>${certificateCell(r)}</td>
      <td>${r.owner_team ? escapeHtml(r.owner_team) : '<span class="muted">Unassigned</span>'}</td>
      <td>${expiryCell(r.expiry_date, r.days_left)}</td>
      <td>${statusPill(r.status)}</td>
      <td>${workflowBadge(r.workflow_status)}</td>
      <td>${ticketCell(r.ticket_number)}</td>
    </tr>
  `).join('');
}

/* ---------------- admin: email notifications ---------------- */

function loadEmailSettings() {
  document.getElementById('smtp-host').value = state.settings.smtp_host || '';
  document.getElementById('smtp-port').value = state.settings.smtp_port || '587';
  document.getElementById('smtp-user').value = state.settings.smtp_user || '';
  document.getElementById('smtp-pass').value = '';
  document.getElementById('smtp-pass').placeholder = state.settings.smtp_pass_set
    ? 'Password is set — leave blank to keep it' : 'No password set yet';
  document.getElementById('smtp-from').value = state.settings.smtp_from || '';
  document.getElementById('smtp-secure').value = state.settings.smtp_secure || 'false';
  document.getElementById('notify-recipients').value = state.settings.notify_recipients || '';
  document.getElementById('email-enabled').value = state.settings.email_enabled || 'false';
  document.getElementById('email-send-day').value = state.settings.email_send_day || '1';
  document.getElementById('last-sent-info').textContent = state.settings.last_monthly_email_sent
    ? `Last scheduled digest sent for: ${monthLabelOf(state.settings.last_monthly_email_sent)}`
    : 'No scheduled digest has been sent yet.';

  const testField = document.getElementById('test-email-address');
  if (!testField.value) {
    testField.value = (state.settings.notify_recipients || '').split(',')[0].trim();
  }
}

document.getElementById('email-settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const payload = {
    smtp_host: document.getElementById('smtp-host').value.trim(),
    smtp_port: document.getElementById('smtp-port').value.trim() || '587',
    smtp_user: document.getElementById('smtp-user').value.trim(),
    smtp_from: document.getElementById('smtp-from').value.trim(),
    smtp_secure: document.getElementById('smtp-secure').value,
    notify_recipients: document.getElementById('notify-recipients').value.trim(),
    email_enabled: document.getElementById('email-enabled').value,
    email_send_day: document.getElementById('email-send-day').value.trim() || '1'
  };
  const smtpPass = document.getElementById('smtp-pass').value;
  if (smtpPass) payload.smtp_pass = smtpPass;

  withBusy(e.submitter, async () => {
    try {
      state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
      loadEmailSettings();
      toast('Email settings saved', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

document.getElementById('btn-send-test').addEventListener('click', (e) => {
  const to = document.getElementById('test-email-address').value.trim();
  if (!to) { toast('Enter an email address to send the test to', 'error'); return; }
  withBusy(e.currentTarget, async () => {
    try {
      await api('/api/notifications/test', { method: 'POST', body: JSON.stringify({ to }) });
      toast(`Test email sent to ${to}`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

document.getElementById('btn-send-now').addEventListener('click', (e) => {
  const button = e.currentTarget;
  const month = localMonthKey();
  confirmAction('Send this month\'s digest now?', `This will email everyone in the recipient list the certificates expiring in ${monthLabelOf(month)}, plus any that have already expired. The scheduled digest will still be sent as normal.`, () => {
    withBusy(button, async () => {
      try {
        const result = await api('/api/notifications/send-now', { method: 'POST', body: JSON.stringify({ month }) });
        const overdue = result.overdue ? ` and ${result.overdue} already expired` : '';
        toast(`Digest sent: ${result.count} certificate(s)${overdue} to ${result.recipients.length} recipient(s)`, 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
});

/* ---------------- admin: alert thresholds ---------------- */

function loadThresholdSettings() {
  document.getElementById('threshold-critical').value = state.settings.threshold_critical_days || '7';
  document.getElementById('threshold-warning').value = state.settings.threshold_warning_days || '30';
  document.getElementById('threshold-upcoming').value = state.settings.threshold_upcoming_days || '90';
}

document.getElementById('thresholds-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('thresholds-form-error');
  errorEl.hidden = true;
  withBusy(e.submitter, async () => {
    try {
      state.settings = await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          threshold_critical_days: document.getElementById('threshold-critical').value.trim(),
          threshold_warning_days: document.getElementById('threshold-warning').value.trim(),
          threshold_upcoming_days: document.getElementById('threshold-upcoming').value.trim()
        })
      });
      loadThresholdSettings();
      updateThresholdLabels();
      toast('Alert thresholds saved', 'success');
      await refreshAll();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
});

/* ---------------- admin: certificate discovery settings ---------------- */

function lastScanText() {
  return state.settings.last_discovery_scan_at
    ? `Last scan: ${formatTimestamp(state.settings.last_discovery_scan_at)}`
    : 'No scan has run yet.';
}

function loadDiscoverySettings() {
  document.getElementById('discovery-targets').value = state.settings.discovery_targets || '';
  document.getElementById('discovery-enabled').value = state.settings.discovery_enabled || 'false';
  document.getElementById('discovery-interval').value = state.settings.discovery_interval_hours || '24';
  document.getElementById('discovery-last-scan-info').textContent = lastScanText();
}

document.getElementById('discovery-settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(e.submitter, async () => {
    try {
      state.settings = await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          discovery_targets: document.getElementById('discovery-targets').value.trim(),
          discovery_enabled: document.getElementById('discovery-enabled').value,
          discovery_interval_hours: document.getElementById('discovery-interval').value.trim() || '24'
        })
      });
      loadDiscoverySettings();
      toast('Discovery settings saved', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

/* ---------------- discovery results view ---------------- */

async function loadDiscoveryResults() {
  const results = await api('/api/discovery/results');
  document.getElementById('discovery-last-scan').textContent = lastScanText();

  const tbody = document.getElementById('discovery-table-body');
  const emptyState = document.getElementById('discovery-empty-state');
  tbody.dataset.results = JSON.stringify(results);

  if (results.length === 0) {
    tbody.innerHTML = '';
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  tbody.innerHTML = results.map((r) => {
    const tracked = !!r.matched_certificate_id;
    const certCell = r.error
      ? `<div class="cell-stack"><span class="error-text">Unreachable</span><span class="cell-secondary">${escapeHtml(r.error)}</span></div>`
      : `<div class="cell-stack cell-title"><span class="cell-primary">${escapeHtml(r.common_name || '—')}</span>` +
        `<span class="cell-secondary">${r.issuer ? `Issued by ${escapeHtml(r.issuer)}` : ''}</span></div>`;
    const trackedCell = r.error
      ? '<span class="muted">—</span>'
      : tracked ? `<span class="tracked-chip">${icon('check-circle')}${escapeHtml(r.matched_certificate_name)}</span>` : '<span class="muted">Not in inventory</span>';
    return `
      <tr>
        <td class="cell-primary">${escapeHtml(r.host)}</td>
        <td class="num">${escapeHtml(r.port)}</td>
        <td>${certCell}</td>
        <td>${r.valid_to ? expiryCell(r.valid_to, r.days_left) : '<span class="muted">—</span>'}</td>
        <td>${r.error ? '<span class="muted">—</span>' : statusPill(r.status)}</td>
        <td>${trackedCell}</td>
        <td class="nowrap meta-text">${escapeHtml(formatTimestamp(r.last_checked_at))}</td>
        <td>
          <div class="row-actions">
            ${tracked || r.error ? '' : `<button data-action="add" data-id="${r.id}" class="link-primary">Add to inventory</button>`}
            <button data-action="dismiss" data-id="${r.id}">Dismiss</button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

document.getElementById('discovery-table-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const results = JSON.parse(document.getElementById('discovery-table-body').dataset.results || '[]');
  const result = results.find((r) => r.id === id);
  if (!result) return;

  if (btn.dataset.action === 'add') {
    openCertModal(null, {
      name: result.common_name || result.host,
      common_name: result.common_name || result.host,
      sans: result.sans,
      issuer: result.issuer,
      issue_date: result.valid_from,
      expiry_date: result.valid_to,
      notes: `Discovered via TLS scan of ${result.host}:${result.port}`
    });
  }
  if (btn.dataset.action === 'dismiss') {
    withBusy(btn, async () => {
      try {
        await api(`/api/discovery/results/${id}/dismiss`, { method: 'POST' });
        toast('Result dismissed', 'success');
        await loadDiscoveryResults();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }
});

document.getElementById('discovery-scan-now').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  withBusy(btn, async () => {
    const label = btn.querySelector('span');
    label.textContent = 'Scanning…';
    try {
      const result = await api('/api/discovery/scan-now', { method: 'POST' });
      if (result.scanned === 0) {
        toast('No scan targets configured — add hosts in Admin → Certificate Discovery', 'error');
      } else {
        toast(`Scan complete: ${result.scanned} host(s) checked, ${result.matched} tracked, ${result.errors} error(s)`, 'success');
      }
      await refreshSettingsQuietly();
      await loadDiscoveryResults();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      label.textContent = 'Scan now';
    }
  });
});

/* ---------------- audit log view ---------------- */

async function loadAuditLog() {
  const entityType = document.getElementById('audit-filter-entity').value;
  const params = new URLSearchParams({ page: state.auditPage, pageSize: state.auditPageSize });
  if (entityType) params.set('entityType', entityType);

  const data = await api(`/api/audit-logs?${params.toString()}`);
  state.auditTotal = data.total;

  const tbody = document.getElementById('audit-table-body');
  tbody.innerHTML = data.rows.map((r) => `
    <tr>
      <td class="nowrap meta-text">${escapeHtml(formatTimestamp(r.created_at))}</td>
      <td class="cell-primary">${escapeHtml(r.username)}</td>
      <td><div class="cell-stack"><span class="event-name">${escapeHtml(ENTITY_LABELS[r.entity_type] || titleCase(r.entity_type))}</span>` +
        `${r.entity_label ? `<span class="cell-secondary">${escapeHtml(r.entity_label)}</span>` : ''}</div></td>
      <td><span class="action-tag">${escapeHtml(actionLabel(r.action))}</span></td>
      <td>${r.details ? `<pre class="audit-details">${escapeHtml(JSON.stringify(r.details, null, 1))}</pre>` : '<span class="muted">—</span>'}</td>
    </tr>
  `).join('') || '<tr><td colspan="5"><div class="empty-state"><p class="empty-title">No events recorded</p></div></td></tr>';

  const totalPages = Math.max(1, Math.ceil(state.auditTotal / state.auditPageSize));
  document.getElementById('audit-page-info').textContent = `Page ${state.auditPage} of ${totalPages} · ${state.auditTotal} events`;
  document.getElementById('audit-prev').disabled = state.auditPage <= 1;
  document.getElementById('audit-next').disabled = state.auditPage >= totalPages;
}

function reloadAuditLog() {
  loadAuditLog().catch((err) => toast(err.message, 'error'));
}

document.getElementById('audit-refresh').addEventListener('click', () => { state.auditPage = 1; reloadAuditLog(); });
document.getElementById('audit-filter-entity').addEventListener('change', () => { state.auditPage = 1; reloadAuditLog(); });
document.getElementById('audit-prev').addEventListener('click', () => { state.auditPage = Math.max(1, state.auditPage - 1); reloadAuditLog(); });
document.getElementById('audit-next').addEventListener('click', () => { state.auditPage += 1; reloadAuditLog(); });

/* ---------------- admin: settings ---------------- */

document.getElementById('settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(e.submitter, async () => {
    try {
      state.settings = await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          org_name: document.getElementById('setting-org-name').value.trim(),
          csr_tool_label: document.getElementById('setting-csr-label').value.trim(),
          csr_tool_url: document.getElementById('setting-csr-url').value.trim()
        })
      });
      document.getElementById('org-name').textContent = state.settings.org_name || '';
      document.title = `${state.settings.org_name || 'Cert Dashboard'} · Cert Dashboard`;
      toast('Settings saved', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

/* ---------------- admin: users ---------------- */

async function loadUsers() {
  const users = await api('/api/users');
  const tbody = document.getElementById('users-table-body');
  tbody.innerHTML = users.map((u) => `
    <tr>
      <td>
        <div class="cell-stack">
          <span class="cell-primary">${escapeHtml(u.displayName)}${u.id === state.user.id ? ' <span class="meta-text">(you)</span>' : ''}${u.mustChangePassword ? '<span class="pending-badge">Password change pending</span>' : ''}</span>
          <span class="cell-secondary">${escapeHtml(u.username)}</span>
        </div>
      </td>
      <td><span class="role-badge ${u.role === 'admin' ? 'admin' : ''}">${u.role === 'admin' ? 'Admin' : 'Editor'}</span></td>
      <td class="nowrap meta-text">${escapeHtml(formatTimestamp(u.createdAt))}</td>
      <td>
        <div class="row-actions">
          <button data-action="edit-user" data-id="${u.id}" class="link-primary">Edit</button>
          <button data-action="reset-password" data-id="${u.id}">Reset password</button>
          ${u.id === state.user.id ? '' : `<button data-action="delete-user" data-id="${u.id}" class="danger">Remove</button>`}
        </div>
      </td>
    </tr>
  `).join('');
  tbody.dataset.users = JSON.stringify(users);
}

document.getElementById('users-table-body').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const users = JSON.parse(document.getElementById('users-table-body').dataset.users || '[]');
  const user = users.find((u) => u.id === id);
  if (!user) return;

  if (btn.dataset.action === 'edit-user') openUserModal(user);
  if (btn.dataset.action === 'reset-password') {
    confirmAction('Reset password?', `Generate a new temporary password for ${user.username}? They will have to change it at next sign-in.`, async () => {
      try {
        const result = await api(`/api/users/${id}/reset-password`, { method: 'POST' });
        showSecret('New temporary password', result.tempPassword);
        await loadUsers();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }
  if (btn.dataset.action === 'delete-user') {
    confirmAction(`Remove ${user.displayName}?`, `${user.displayName} (${user.username}) will lose access immediately. Certificates they created keep their name in the history.`, async () => {
      try {
        await api(`/api/users/${id}`, { method: 'DELETE' });
        toast(`${user.displayName} was removed`, 'success');
        await loadUsers();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }
});

function showSecret(title, value) {
  document.getElementById('secret-modal-title').textContent = title;
  document.getElementById('secret-modal-value').textContent = value;
  openModal('secret-modal');
}
document.getElementById('secret-modal-close').addEventListener('click', () => closeModal('secret-modal'));

function openUserModal(user) {
  document.getElementById('user-form-error').hidden = true;
  document.getElementById('user-modal-title').textContent = user ? `Edit ${user.displayName}` : 'Add user';
  document.getElementById('user-id').value = user ? user.id : '';
  document.getElementById('user-username').value = user ? user.username : '';
  document.getElementById('user-username').disabled = !!user;
  document.getElementById('user-display-name').value = user ? user.displayName : '';
  document.getElementById('user-role').value = user ? user.role : 'editor';
  openModal('user-modal');
}

document.getElementById('btn-add-user').addEventListener('click', () => openUserModal(null));
document.getElementById('user-modal-cancel').addEventListener('click', () => closeModal('user-modal'));

document.getElementById('user-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('user-form-error');
  errorEl.hidden = true;
  const id = document.getElementById('user-id').value;
  const displayName = document.getElementById('user-display-name').value.trim();
  const role = document.getElementById('user-role').value;

  withBusy(e.submitter, async () => {
    try {
      if (id) {
        await api(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify({ displayName, role }) });
        closeModal('user-modal');
        if (Number(id) === state.user.id) {
          // Your own role or name changed: reload so navigation and permissions match.
          window.location.reload();
          return;
        }
        toast('User updated', 'success');
        await loadUsers();
      } else {
        const username = document.getElementById('user-username').value.trim();
        const result = await api('/api/users', { method: 'POST', body: JSON.stringify({ username, displayName, role }) });
        closeModal('user-modal');
        await loadUsers();
        showSecret('Temporary password', result.tempPassword);
      }
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
});

/* ---------------- password change ---------------- */

function setPasswordModalMode(forced) {
  state.forcedPasswordChange = forced;
  const current = document.getElementById('current-password');
  current.closest('label').hidden = forced;
  // A hidden but still-required field makes the browser refuse to submit the form.
  current.required = !forced;
  document.getElementById('password-modal-cancel').hidden = forced;
  document.getElementById('password-modal-title').textContent = forced ? 'Set a new password' : 'Change password';
  document.getElementById('password-modal-note').hidden = !forced;
  document.getElementById('password-form').reset();
  document.getElementById('password-form-error').hidden = true;
}

function openForcedPasswordModal() {
  if (state.forcedPasswordChange && !document.getElementById('password-modal').hidden) return;
  setPasswordModalMode(true);
  openModal('password-modal');
}

document.getElementById('btn-change-password').addEventListener('click', () => {
  setPasswordModalMode(false);
  openModal('password-modal');
});
document.getElementById('password-modal-cancel').addEventListener('click', () => {
  if (!state.forcedPasswordChange) closeModal('password-modal');
});

document.getElementById('password-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('password-form-error');
  errorEl.hidden = true;
  const currentPassword = document.getElementById('current-password').value;
  const newPassword = document.getElementById('pw-new-password').value;
  const confirmPassword = document.getElementById('pw-confirm-password').value;

  if (newPassword !== confirmPassword) {
    errorEl.textContent = 'New passwords do not match';
    errorEl.hidden = false;
    return;
  }

  withBusy(e.submitter, async () => {
    try {
      await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
      if (state.forcedPasswordChange) {
        window.location.reload();
        return;
      }
      toast('Password updated', 'success');
      closeModal('password-modal');
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
});

/* ---------------- logout ---------------- */

document.getElementById('btn-logout').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // Signing out locally is still the right outcome if the server call failed.
  }
  window.location.href = '/login.html';
});

bootstrap();
