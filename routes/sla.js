const router = require('express').Router();
const pool   = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/', authenticate, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sla_policies ORDER BY priority');
  res.json({ success: true, data: rows });
});

router.put('/:priority', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { first_response_mins, resolution_mins } = req.body;
    const { rows: [p] } = await pool.query(
      `INSERT INTO sla_policies (priority, first_response_mins, resolution_mins)
       VALUES ($1,$2,$3)
       ON CONFLICT (priority) DO UPDATE
       SET first_response_mins=$2, resolution_mins=$3 RETURNING *`,
      [req.params.priority, first_response_mins, resolution_mins]);
    res.json({ success: true, data: p });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Live SLA status for all active tickets
router.get('/status', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.id, t.ticket_number, t.subject, t.priority, t.status,
        a.name AS agent_name, cu.name AS customer_org,
        sp.first_response_mins, sp.resolution_mins,
        EXTRACT(EPOCH FROM (NOW()-t.created_at))/60 AS age_mins,
        ROUND((EXTRACT(EPOCH FROM (NOW()-t.created_at))/60 / sp.resolution_mins * 100)::numeric, 1) AS sla_pct
      FROM tickets t
      LEFT JOIN users a ON a.id=t.agent_id
      LEFT JOIN customers cu ON cu.id=t.customer_org_id
      LEFT JOIN sla_policies sp ON sp.priority=t.priority
      WHERE t.status NOT IN ('Resolved','Closed')
      ORDER BY sla_pct DESC NULLS LAST
      LIMIT 100`);
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
