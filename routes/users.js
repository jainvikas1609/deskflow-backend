const router = require('express').Router();
const pool   = require('../config/db');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, email, role, active FROM users ORDER BY name');
  res.json({ success: true, data: rows });
});

router.get('/agents', authenticate, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, email FROM users
     WHERE role IN ('agent','supervisor') AND active=true ORDER BY name`);
  res.json({ success: true, data: rows });
});

module.exports = router;
