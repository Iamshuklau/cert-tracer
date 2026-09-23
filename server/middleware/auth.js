const db = require('../db');

// The session only stores who logged in; role, name and existence are re-read on every
// request so that deleting or demoting a user takes effect immediately.
function loadUser(req) {
  if (!req.session || !req.session.user) return null;
  const row = db.prepare('SELECT id, username, display_name, role, must_change_password FROM users WHERE id = ?')
    .get(req.session.user.id);
  if (!row) return null;
  req.session.user = { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
  req.mustChangePassword = !!row.must_change_password;
  return req.session.user;
}

function authenticate(req, res, { adminOnly }) {
  const user = loadUser(req);
  if (!user) {
    if (req.session) req.session.user = undefined;
    res.status(401).json({ error: 'Not authenticated' });
    return false;
  }
  // /api/auth/* (me, change-password, logout) must stay reachable while a password change is pending.
  if (req.mustChangePassword && req.baseUrl !== '/api/auth') {
    res.status(403).json({ error: 'You must change your password before continuing', code: 'PASSWORD_CHANGE_REQUIRED' });
    return false;
  }
  if (adminOnly && user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return false;
  }
  return true;
}

function requireAuth(req, res, next) {
  if (authenticate(req, res, { adminOnly: false })) next();
}

function requireAdmin(req, res, next) {
  if (authenticate(req, res, { adminOnly: true })) next();
}

module.exports = { requireAuth, requireAdmin };
