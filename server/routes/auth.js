const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { logEvent } = require('../audit');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failedAttempts = new Map(); // key: "username|ip" -> { count, firstAt }

function attemptKey(req, username) {
  return `${username.toLowerCase()}|${req.ip}`;
}

function isLockedOut(key) {
  const entry = failedAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > LOCKOUT_MS) {
    failedAttempts.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILED_ATTEMPTS;
}

function recordFailure(key) {
  const entry = failedAttempts.get(key);
  if (!entry || Date.now() - entry.firstAt > LOCKOUT_MS) {
    failedAttempts.set(key, { count: 1, firstAt: Date.now() });
  } else {
    entry.count++;
  }
}

router.post('/login', (req, res, next) => {
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const key = attemptKey(req, username);
  if (isLockedOut(key)) {
    return res.status(429).json({ error: 'Too many failed sign-in attempts. Try again in 15 minutes.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    recordFailure(key);
    logEvent({ entityType: 'auth', action: 'login_failed', details: { username } });
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  failedAttempts.delete(key);

  // New session id on login prevents session-fixation.
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user = {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role
    };
    logEvent({ entityType: 'auth', action: 'login', user: req.session.user });
    res.json({ user: req.session.user, mustChangePassword: !!user.must_change_password });
  });
});

router.post('/logout', requireAuth, (req, res) => {
  const user = req.session.user;
  logEvent({ entityType: 'auth', action: 'logout', user });
  req.session.destroy(() => {
    res.clearCookie('cert_dashboard_sid');
    res.json({ ok: true });
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user, mustChangePassword: !!req.mustChangePassword });
});

router.post('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const forced = !!user.must_change_password;
  if (!forced) {
    if (!currentPassword || !bcrypt.compareSync(currentPassword, user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
  }
  if (bcrypt.compareSync(newPassword, user.password_hash)) {
    return res.status(400).json({ error: 'New password must be different from the current one' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, user.id);
  logEvent({ entityType: 'auth', action: 'password_changed', user: req.session.user });

  res.json({ ok: true });
});

module.exports = router;
