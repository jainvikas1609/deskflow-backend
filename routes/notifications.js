const router = require('express').Router();
const pool   = require('../config/db');
const { authenticate } = require('../middleware/auth');

router.get('/breaches', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ba.*, t.ticket_number, t.subject, t.priority, t.status, t.agent_id,
        a.name AS agent_name, cu.name AS customer_org,
        ROUND((EXTRACT(EPOCH FROM (NOW()-t.created_at))/60 /
          NULLIF(COALESCE(cs.resolution_mins, sp.resolution_mins),0)*100)::numeric,1) AS sla_pct
      FROM sla_breach_alerts ba
      JOIN tickets t ON t.id=ba.ticket_id
      LEFT JOIN users a ON a.id=t.agent_id
      LEFT JOIN customers cu ON cu.id=t.customer_org_id
      LEFT JOIN sla_policies sp ON sp.priority=t.priority
      LEFT JOIN customer_slas cs ON cs.customer_id=t.customer_org_id AND cs.priority=t.priority
      WHERE ba.dismissed_by IS NULL
        AND t.status NOT IN ('Resolved','Closed')
      ORDER BY t.priority DESC, ba.created_at DESC
      LIMIT 50`);
    res.json({ success:true, data:rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/breaches/:id/dismiss', authenticate, async (req, res) => {
  try {
    await pool.query(
      'UPDATE sla_breach_alerts SET dismissed_by=$1, dismissed_at=NOW() WHERE id=$2',
      [req.user.id, req.params.id]);
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/breaches/dismiss-all', authenticate, async (req, res) => {
  try {
    await pool.query(
      'UPDATE sla_breach_alerts SET dismissed_by=$1, dismissed_at=NOW() WHERE dismissed_by IS NULL',
      [req.user.id]);
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SLA stagnation check — tickets not updated in X hours
router.get('/stagnant', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.id, t.ticket_number, t.subject, t.priority, t.status,
        a.name AS agent_name,
        ROUND(EXTRACT(EPOCH FROM (NOW()-t.updated_at))/3600::numeric,1) AS hours_stagnant
      FROM tickets t LEFT JOIN users a ON a.id=t.agent_id
      WHERE t.status NOT IN ('Resolved','Closed','Pending','On Hold')
        AND t.updated_at < NOW() - INTERVAL '4 hours'
      ORDER BY t.updated_at ASC LIMIT 20`);
    res.json({ success:true, data:rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
