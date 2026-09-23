const db = require('./db');

function logEvent({ entityType, entityId = null, entityLabel = null, action, details = null, user }) {
  db.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, entity_label, action, details, user_id, username)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entityType,
    entityId,
    entityLabel,
    action,
    details ? JSON.stringify(details) : null,
    user ? user.id : null,
    user ? user.username : 'system'
  );
}

module.exports = { logEvent };
