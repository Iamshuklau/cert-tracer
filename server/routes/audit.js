const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAdmin, (req, res) => {
  const { entityType, action, username, page = '1', pageSize = '50' } = req.query;
  const conditions = [];
  const params = {};

  if (entityType) { conditions.push('entity_type = @entityType'); params.entityType = entityType; }
  if (action) { conditions.push('action = @action'); params.action = action; }
  if (username) { conditions.push('username = @username'); params.username = username; }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 200);
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (pageNum - 1) * limit;

  const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_log ${where}`).get(params).c;
  // id breaks ties between events logged in the same second so their order is stable.
  const rows = db.prepare(
    `SELECT * FROM audit_log ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`
  ).all(params);

  res.json({
    total, page: pageNum, pageSize: limit,
    rows: rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }))
  });
});

module.exports = router;
