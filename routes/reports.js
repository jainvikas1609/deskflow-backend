const router = require('express').Router();
const pool   = require('../config/db');
const { authenticate } = require('../middleware/auth');

router.get('/summary', authenticate, async (req, res) => {
  try {
    const [total, open, resolved, escalated, urgent] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM tickets'),
      pool.query(`SELECT COUNT(*) FROM tickets WHERE status NOT IN ('Resolved','Closed')`),
      pool.query(`SELECT COUNT(*) FROM tickets WHERE status='Resolved'`),
      pool.query(`SELECT COUNT(*) FROM tickets WHERE status='Escalated'`),
      pool.query(`SELECT COUNT(*) FROM tickets WHERE priority='Urgent' AND status NOT IN ('Resolved','Closed')`),
    ]);
    res.json({ success: true, data: {
      total:     parseInt(total.rows[0].count),
      open:      parseInt(open.rows[0].count),
      resolved:  parseInt(resolved.rows[0].count),
      escalated: parseInt(escalated.rows[0].count),
      urgent:    parseInt(urgent.rows[0].count),
    }});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/by-status', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT status, COUNT(*) AS count FROM tickets GROUP BY status ORDER BY count DESC`);
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/by-priority', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT priority, COUNT(*) AS count FROM tickets GROUP BY priority ORDER BY
       CASE priority WHEN 'Urgent' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 ELSE 4 END`);
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/by-category', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(category,'Uncategorised') AS category, COUNT(*) AS count
       FROM tickets GROUP BY category ORDER BY count DESC LIMIT 10`);
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/by-day', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT TO_CHAR(created_at,'Dy') AS day, DATE_TRUNC('day',created_at) AS date, COUNT(*) AS count
       FROM tickets
       WHERE created_at >= NOW() - INTERVAL '30 days'
       GROUP BY DATE_TRUNC('day',created_at), TO_CHAR(created_at,'Dy')
       ORDER BY date DESC LIMIT 14`);
    res.json({ success: true, data: rows.reverse() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/by-agent', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.name, u.id,
        COUNT(t.id) AS total,
        COUNT(CASE WHEN t.status NOT IN ('Resolved','Closed') THEN 1 END) AS open,
        COUNT(CASE WHEN t.status='Resolved' THEN 1 END) AS resolved
       FROM users u
       LEFT JOIN tickets t ON t.agent_id=u.id
       WHERE u.role IN ('agent','supervisor') AND u.active=true
       GROUP BY u.id, u.name ORDER BY total DESC`);
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/by-customer', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cu.name, cu.id,
        COUNT(t.id) AS total,
        COUNT(CASE WHEN t.status NOT IN ('Resolved','Closed') THEN 1 END) AS open
       FROM customers cu
       LEFT JOIN tickets t ON t.customer_org_id=cu.id
       GROUP BY cu.id, cu.name ORDER BY open DESC`);
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
