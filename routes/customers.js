const router = require('express').Router();
const pool   = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, COUNT(t.id) AS ticket_count
       FROM customers c
       LEFT JOIN tickets t ON t.customer_org_id = c.id
       GROUP BY c.id ORDER BY c.name`);
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const { rows: [customer] } = await pool.query('SELECT * FROM customers WHERE id=$1', [req.params.id]);
    if (!customer) return res.status(404).json({ error: 'Not found' });
    const { rows: tickets } = await pool.query(
      `SELECT t.*, a.name AS agent_name FROM tickets t
       LEFT JOIN users a ON a.id=t.agent_id
       WHERE t.customer_org_id=$1 ORDER BY t.updated_at DESC LIMIT 50`, [req.params.id]);
    res.json({ success: true, data: { ...customer, tickets } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', authenticate, authorize('admin','supervisor'), async (req, res) => {
  try {
    const { name, contact_email, contact_phone, account_manager, sla_tier, address } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const { rows: [c] } = await pool.query(
      `INSERT INTO customers (name,contact_email,contact_phone,account_manager,sla_tier,address)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name,contact_email,contact_phone,account_manager,sla_tier||'Standard',address]);
    res.status(201).json({ success: true, data: c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', authenticate, authorize('admin','supervisor'), async (req, res) => {
  try {
    const fields = ['name','contact_email','contact_phone','account_manager','sla_tier','address','active'];
    const updates = []; const params = [];
    for (const f of fields) {
      if (req.body[f]!==undefined) { params.push(req.body[f]); updates.push(`${f}=$${params.length}`); }
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    const { rows: [c] } = await pool.query(
      `UPDATE customers SET ${updates.join(',')} WHERE id=$${params.length} RETURNING *`, params);
    res.json({ success: true, data: c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  await pool.query('UPDATE customers SET active=false WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
