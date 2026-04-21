const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool   = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT u.*,c.name AS customer_org_name FROM users u LEFT JOIN customers c ON c.id=u.customer_org_id ORDER BY u.name`);
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.get('/agents', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id,name,email,role FROM users WHERE role IN ('agent','supervisor','admin') AND active=true ORDER BY name`);
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { name,email,role,password,department,phone,company_name,customer_org_id } = req.body;
    if (!name||!email||!role||!password) return res.status(400).json({ error:'All fields required' });
    const hash = await bcrypt.hash(password, 10);
    const { rows:[u] } = await pool.query(
      `INSERT INTO users (name,email,role,password_hash,active,department,phone,company_name,customer_org_id) VALUES ($1,$2,$3,$4,true,$5,$6,$7,$8) RETURNING id,name,email,role,active,department,phone,company_name`,
      [name,email,role,hash,department||null,phone||null,company_name||null,customer_org_id||null]);
    res.status(201).json({ success:true, data:u });
  } catch(e) {
    if (e.code==='23505') return res.status(400).json({error:'Email already exists'});
    res.status(500).json({error:e.message});
  }
});
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { name,email,role,active,password,department,phone,company_name,customer_org_id } = req.body;
    const updates=[]; const params=[];
    const fields={name,email,role,department,phone,company_name,customer_org_id};
    for (const [k,v] of Object.entries(fields)) {
      if (v!==undefined) { params.push(v); updates.push(`${k}=$${params.length}`); }
    }
    if (active!==undefined) { params.push(active); updates.push(`active=$${params.length}`); }
    if (password) { const h=await bcrypt.hash(password,10); params.push(h); updates.push(`password_hash=$${params.length}`); }
    if (!updates.length) return res.status(400).json({error:'Nothing to update'});
    params.push(req.params.id);
    const { rows:[u] } = await pool.query(`UPDATE users SET ${updates.join(',')} WHERE id=$${params.length} RETURNING id,name,email,role,active,department,phone,company_name`,params);
    res.json({ success:true, data:u });
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.patch('/:id/deactivate', authenticate, authorize('admin'), async (req, res) => {
  await pool.query('UPDATE users SET active=false WHERE id=$1', [req.params.id]);
  res.json({ success:true });
});
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    await pool.query('UPDATE tickets SET agent_id=NULL WHERE agent_id=$1', [req.params.id]);
    await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({error:e.message}); }
});
module.exports = router;
