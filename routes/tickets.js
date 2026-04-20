const router = require('express').Router();
const pool   = require('../config/db');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, async (req, res) => {
  try {
    const { status, priority, category, agent, customer_id, q } = req.query;
    let sql = `SELECT t.*, a.name AS agent_name, c.name AS customer_name,
      cu.name AS customer_org,
      sp.first_response_mins, sp.resolution_mins,
      EXTRACT(EPOCH FROM (NOW() - t.created_at))/60 AS age_mins
      FROM tickets t
      LEFT JOIN users a ON a.id = t.agent_id
      LEFT JOIN users c ON c.id = t.customer_id
      LEFT JOIN customers cu ON cu.id = t.customer_org_id
      LEFT JOIN sla_policies sp ON sp.priority = t.priority
      WHERE 1=1`;
    const params = [];
    if (status)      { params.push(status);      sql += ` AND t.status=$${params.length}`; }
    if (priority)    { params.push(priority);    sql += ` AND t.priority=$${params.length}`; }
    if (category)    { params.push(category);    sql += ` AND t.category=$${params.length}`; }
    if (agent)       { params.push(agent);       sql += ` AND t.agent_id=$${params.length}`; }
    if (customer_id) { params.push(customer_id); sql += ` AND t.customer_org_id=$${params.length}`; }
    if (q)           { params.push(`%${q}%`);    sql += ` AND (t.subject ILIKE $${params.length} OR t.ticket_number ILIKE $${params.length})`; }
    // Role-based: customers only see their org tickets
    if (req.user.role === 'customer') {
      params.push(req.user.id);
      sql += ` AND t.customer_id=$${params.length}`;
    }
    sql += ' ORDER BY t.updated_at DESC LIMIT 500';
    const { rows } = await pool.query(sql, params);
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const { rows: [ticket] } = await pool.query(
      `SELECT t.*, a.name AS agent_name, c.name AS customer_name, cu.name AS customer_org
       FROM tickets t
       LEFT JOIN users a ON a.id=t.agent_id
       LEFT JOIN users c ON c.id=t.customer_id
       LEFT JOIN customers cu ON cu.id=t.customer_org_id
       WHERE t.id=$1`, [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    const { rows: thread } = await pool.query(
      `SELECT th.*, u.name AS author_name FROM ticket_threads th
       LEFT JOIN users u ON u.id=th.author_id
       WHERE th.ticket_id=$1 ORDER BY th.created_at ASC`, [req.params.id]);
    const { rows: history } = await pool.query(
      `SELECT h.*, u.name AS actor_name FROM ticket_history h
       LEFT JOIN users u ON u.id=h.actor_id
       WHERE h.ticket_id=$1 ORDER BY h.changed_at ASC`, [req.params.id]);
    res.json({ success: true, data: { ...ticket, thread, history } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', authenticate, async (req, res) => {
  try {
    const { subject, description, priority='Medium', category, channel='Web Portal',
            agent_id, customer_org_id, tags } = req.body;
    if (!subject) return res.status(400).json({ error: 'Subject required' });
    const { rows: [ticket] } = await pool.query(
      `INSERT INTO tickets (subject, description, priority, category, channel,
        customer_id, agent_id, customer_org_id, tags, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [subject, description, priority, category, channel,
       req.user.id, agent_id||null, customer_org_id||null,
       tags||null, agent_id?'Assigned':'New']);
    await pool.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, field_changed, new_value)
       VALUES ($1,$2,'status','New')`, [ticket.id, req.user.id]);
    res.status(201).json({ success: true, data: ticket });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/status', authenticate, async (req, res) => {
  try {
    const { status, reason } = req.body;
    const { rows: [old] } = await pool.query('SELECT status FROM tickets WHERE id=$1', [req.params.id]);
    if (!old) return res.status(404).json({ error: 'Not found' });
    await pool.query('UPDATE tickets SET status=$1, updated_at=NOW() WHERE id=$2', [status, req.params.id]);
    await pool.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, field_changed, old_value, new_value)
       VALUES ($1,$2,'status',$3,$4)`, [req.params.id, req.user.id, old.status, status]);
    res.json({ success: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/assign', authenticate, async (req, res) => {
  try {
    const { agent_id } = req.body;
    const { rows: [old] } = await pool.query('SELECT agent_id FROM tickets WHERE id=$1', [req.params.id]);
    await pool.query(
      `UPDATE tickets SET agent_id=$1, status=CASE WHEN status='New' THEN 'Assigned' ELSE status END, updated_at=NOW() WHERE id=$2`,
      [agent_id, req.params.id]);
    await pool.query(
      `INSERT INTO ticket_history (ticket_id, actor_id, field_changed, old_value, new_value)
       VALUES ($1,$2,'agent_id',$3,$4)`, [req.params.id, req.user.id, old.agent_id, agent_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', authenticate, async (req, res) => {
  try {
    const allowed = ['subject','description','priority','category','tags','customer_org_id'];
    const updates = []; const params = [];
    for (const [k, v] of Object.entries(req.body)) {
      if (allowed.includes(k)) { params.push(v); updates.push(`${k}=$${params.length}`); }
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    await pool.query(`UPDATE tickets SET ${updates.join(',')}, updated_at=NOW() WHERE id=$${params.length}`, params);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/comments', authenticate, async (req, res) => {
  try {
    const { content, type='public' } = req.body;
    if (!content) return res.status(400).json({ error: 'Content required' });
    const { rows: [comment] } = await pool.query(
      `INSERT INTO ticket_threads (ticket_id, author_id, type, content)
       VALUES ($1,$2,$3,$4) RETURNING *`, [req.params.id, req.user.id, type, content]);
    await pool.query('UPDATE tickets SET updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.status(201).json({ success: true, data: comment });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
