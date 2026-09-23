const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { transaction } = require('../tx');
const { logEvent } = require('../audit');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
const ROLES = ['admin', 'editor'];
const USERNAME_RE = /^[A-Za-z0-9._@-]{2,64}$/;

function publicUser(u) {
  return {
    id: u.id, username: u.username, displayName: u.display_name,
    role: u.role, mustChangePassword: !!u.must_change_password, createdAt: u.created_at
  };
}

function adminCount() {
  return db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin'`).get().c;
}

router.get('/', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at ASC, id ASC').all();
  res.json(rows.map(publicUser));
});

router.post('/', requireAdmin, (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const displayName = String((req.body && req.body.displayName) || '').trim();
  const role = req.body && req.body.role;
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 2-64 characters: letters, digits, . _ @ -' });
  }
  if (!displayName) return res.status(400).json({ error: 'Display name is required' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}` });

  const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (existing) return res.status(409).json({ error: 'Username already exists' });

  const tempPassword = crypto.randomBytes(9).toString('base64url');
  const hash = bcrypt.hashSync(tempPassword, 10);
  const info = db.prepare(
    `INSERT INTO users (username, password_hash, display_name, role, must_change_password) VALUES (?, ?, ?, ?, 1)`
  ).run(username, hash, displayName, role);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  logEvent({ entityType: 'user', entityId: user.id, entityLabel: user.username, action: 'create', details: { role }, user: req.session.user });

  res.status(201).json({ ...publicUser(user), tempPassword });
});

router.put('/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  const role = req.body && req.body.role !== undefined ? req.body.role : existing.role;
  const displayName = req.body && req.body.displayName !== undefined
    ? String(req.body.displayName).trim()
    : existing.display_name;

  if (!ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}` });
  if (!displayName) return res.status(400).json({ error: 'Display name is required' });

  const changes = {};
  if (role !== existing.role) {
    if (existing.role === 'admin' && adminCount() <= 1) {
      return res.status(400).json({ error: 'Cannot remove the last admin' });
    }
    changes.role = { from: existing.role, to: role };
  }
  if (displayName !== existing.display_name) {
    changes.displayName = { from: existing.display_name, to: displayName };
  }

  db.prepare('UPDATE users SET display_name = ?, role = ? WHERE id = ?').run(displayName, role, existing.id);

  if (Object.keys(changes).length) {
    logEvent({ entityType: 'user', entityId: existing.id, entityLabel: existing.username, action: 'update', details: { changes }, user: req.session.user });
  }

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  res.json(publicUser(updated));
});

router.post('/:id/reset-password', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  const tempPassword = crypto.randomBytes(9).toString('base64url');
  const hash = bcrypt.hashSync(tempPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash, existing.id);

  logEvent({ entityType: 'user', entityId: existing.id, entityLabel: existing.username, action: 'password_reset', user: req.session.user });

  res.json({ tempPassword });
});

router.delete('/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'User not found' });
  if (existing.id === req.session.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  if (existing.role === 'admin' && adminCount() <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last admin' });
  }

  // Certificates keep the author's name in created_by_name/updated_by_name, so the id
  // references can be cleared rather than blocking the delete on a foreign key.
  transaction(() => {
    db.prepare('UPDATE certificates SET created_by = NULL WHERE created_by = ?').run(existing.id);
    db.prepare('UPDATE certificates SET updated_by = NULL WHERE updated_by = ?').run(existing.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(existing.id);
  });
  logEvent({ entityType: 'user', entityId: existing.id, entityLabel: existing.username, action: 'delete', user: req.session.user });

  res.json({ ok: true });
});

module.exports = router;
