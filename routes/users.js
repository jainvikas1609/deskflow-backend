const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool   = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/', authenticate, async (req, res) => {
  const { rows } = await pool.query('SELECT id,name,email,role,active,created_at FROM users ORDER BY name');
  res.json({ success: true, data: rows });
});

router.get('/agents', authenticate, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id,name,email,role FROM users WHERE role IN ('agent','supervisor','admin') AND active=true ORDER BY name`);
  res.json({ success: true, data: rows });
});

router.post('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { name, email, role, password } = req.body;
    if (!name||!email||!role||!password) return res.status(400).json({ error: 'All fields required' });
    const hash = await bcrypt.hash(password, 10);
    const { rows: [user] } = await pool.query(
      `INSERT INTO users (name,email,role,password_hash,active) VALUES ($1,$2,$3,$4,true)
       RETURNING id,name,email,role,active`, [name,email,role,hash]);
    res.status(201).json({ success: true, data: user });
  } catch (e) {
    if (e.code==='23505') return res.status(400).json({ error: 'Email already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { name, email, role, active, password } = req.body;
    const updates = []; const params = [];
    if (name!==undefined)   { params.push(name);   updates.push(`name=$${params.length}`); }
    if (email!==undefined)  { params.push(email);  updates.push(`email=$${params.length}`); }
    if (role!==undefined)   { params.push(role);   updates.push(`role=$${params.length}`); }
    if (active!==undefined) { params.push(active); updates.push(`active=$${params.length}`); }
    if (password) { const h=await bcrypt.hash(password,10); params.push(h); updates.push(`password_hash=$${params.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    const { rows: [user] } = await pool.query(
      `UPDATE users SET ${updates.join(',')} WHERE id=$${params.length} RETURNING id,name,email,role,active`, params);
    res.json({ success: true, data: user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  await pool.query('UPDATE users SET active=false WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
