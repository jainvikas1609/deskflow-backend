const router = require('express').Router();
const pool   = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/settings', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM system_settings');
    const s={}; rows.forEach(r=>{s[r.key]=r.value;});
    res.json({ success:true, data:s });
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.put('/settings/:key', authenticate, authorize('admin'), async (req, res) => {
  try {
    await pool.query(`INSERT INTO system_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2,updated_at=NOW()`,[req.params.key,req.body.value]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.get('/categories', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM ticket_categories ORDER BY name');
    res.json({ success:true, data:rows });
  } catch(e) { res.json({ success:true, data:[] }); }
});
router.post('/categories', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { rows:[c] } = await pool.query('INSERT INTO ticket_categories (name) VALUES ($1) RETURNING *',[req.body.name]);
    res.status(201).json({ success:true, data:c });
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.delete('/categories/:id', authenticate, authorize('admin'), async (req, res) => {
  await pool.query('DELETE FROM ticket_categories WHERE id=$1',[req.params.id]);
  res.json({ success:true });
});
router.get('/permissions', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM role_permissions ORDER BY role,permission');
    res.json({ success:true, data:rows });
  } catch(e) { res.json({ success:true, data:[] }); }
});
router.put('/permissions', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { role,permission,allowed } = req.body;
    await pool.query(`INSERT INTO role_permissions (role,permission,allowed) VALUES ($1,$2,$3) ON CONFLICT (role,permission) DO UPDATE SET allowed=$3`,[role,permission,allowed]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({error:e.message}); }
});
module.exports = router;
