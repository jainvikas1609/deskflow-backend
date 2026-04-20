const router = require('express').Router();
const pool   = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

// GET system settings
router.get('/settings', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM system_settings');
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json({ success: true, data: settings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// UPDATE system setting
router.put('/settings/:key', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { value } = req.body;
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
      [req.params.key, value]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET ticket categories (configurable)
router.get('/categories', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM ticket_categories ORDER BY name');
    res.json({ success: true, data: rows });
  } catch (e) {
    // Fallback to defaults if table doesn't exist
    res.json({ success: true, data: [
      {id:1,name:'Network Outage'},{id:2,name:'EKAM Platform'},
      {id:3,name:'Billing & Accounts'},{id:4,name:'Hardware & Equipment'},
      {id:5,name:'SLA Breach'},{id:6,name:'Access & Authentication'},
      {id:7,name:'Configuration'},{id:8,name:'Performance Issue'},{id:9,name:'General Enquiry'}
    ]});
  }
});

// POST add category
router.post('/categories', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { name } = req.body;
    const { rows: [c] } = await pool.query(
      'INSERT INTO ticket_categories (name) VALUES ($1) RETURNING *', [name]);
    res.status(201).json({ success: true, data: c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE category
router.delete('/categories/:id', authenticate, authorize('admin'), async (req, res) => {
  await pool.query('DELETE FROM ticket_categories WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
