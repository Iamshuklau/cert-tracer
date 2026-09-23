const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');

require('./db'); // ensures schema + seed data exist before routes load

const { SqliteSessionStore } = require('./sessionStore');
const authRoutes = require('./routes/auth');
const certificateRoutes = require('./routes/certificates');
const settingsRoutes = require('./routes/settings');
const userRoutes = require('./routes/users');
const auditRoutes = require('./routes/audit');
const notificationRoutes = require('./routes/notifications');
const discoveryRoutes = require('./routes/discovery');
const { startScheduler } = require('./scheduler');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SECRET_FILE = path.join(DATA_DIR, 'session-secret.txt');
if (!fs.existsSync(SECRET_FILE)) {
  fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'));
}
const sessionSecret = fs.readFileSync(SECRET_FILE, 'utf8').trim();

const app = express();
const PORT = process.env.PORT || 3000;
// Set COOKIE_SECURE=true when serving over HTTPS (e.g. behind nginx/IIS doing TLS).
const secureCookies = process.env.COOKIE_SECURE === 'true';
if (secureCookies) app.set('trust proxy', 1);

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(session({
  store: new SqliteSessionStore(),
  secret: sessionSecret,
  name: 'cert_dashboard_sid',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies,
    maxAge: 12 * 60 * 60 * 1000
  }
}));

app.use('/api/auth', authRoutes);
app.use('/api/certificates', certificateRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/users', userRoutes);
app.use('/api/audit-logs', auditRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/discovery', discoveryRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use(express.static(path.join(__dirname, '..', 'public')));

// Always answer API errors with JSON and never leak stack traces to the browser.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 2 MB)' : err.message;
    return res.status(400).json({ error: message });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

app.listen(PORT, () => {
  console.log(`Cert Dashboard running at http://localhost:${PORT}`);
  startScheduler();
});
