const router = require('express').Router();
const pool   = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

// Trigger CSAT for a closed ticket
router.post('/trigger/:ticketId', authenticate, authorize('admin','supervisor','agent'), async (req, res) => {
  try {
    const { rows:[ticket] } = await pool.query(
      'SELECT id,status,customer_id FROM tickets WHERE id=$1', [req.params.ticketId]);
    if (!ticket) return res.status(404).json({ error:'Ticket not found' });
    if (!['Resolved','Closed'].includes(ticket.status))
      return res.status(400).json({ error:'CSAT can only be triggered for Resolved or Closed tickets' });
    if (!ticket.customer_id)
      return res.status(400).json({ error:'No customer linked to this ticket' });
    const { rows:[survey] } = await pool.query(
      `INSERT INTO csat_surveys (ticket_id,triggered_by,customer_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (ticket_id) DO UPDATE SET triggered_by=$2, triggered_at=NOW(), responded=false
       RETURNING *`, [req.params.ticketId, req.user.id, ticket.customer_id]);
    res.json({ success:true, data:survey });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Customer submits response
router.post('/respond/:surveyId', authenticate, async (req, res) => {
  try {
    const { score, comment } = req.body;
    if (![5,10].includes(Number(score)))
      return res.status(400).json({ error:'Score must be 5 (thumbs down) or 10 (thumbs up)' });
    const { rows:[survey] } = await pool.query(
      `UPDATE csat_surveys SET score=$1, comment=$2, responded=true, responded_at=NOW()
       WHERE id=$3 AND customer_id=$4 RETURNING *`,
      [score, comment, req.params.surveyId, req.user.id]);
    if (!survey) return res.status(403).json({ error:'Not authorized or survey not found' });
    res.json({ success:true, data:survey });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dismiss pending CSAT (customer declines)
router.post('/dismiss/:surveyId', authenticate, async (req, res) => {
  try {
    await pool.query(
      `UPDATE csat_surveys SET responded=true, responded_at=NOW(), score=NULL
       WHERE id=$1 AND customer_id=$2`, [req.params.surveyId, req.user.id]);
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get CSAT dashboard data
router.get('/dashboard', authenticate, async (req, res) => {
  try {
    const { from, to, agent_id, customer_id } = req.query;
    let where = `WHERE cs.responded=true AND cs.score IS NOT NULL
      AND cs.responded_at >= COALESCE($1::timestamptz, NOW()-INTERVAL '30 days')
      AND cs.responded_at <= COALESCE($2::timestamptz, NOW())`;
    const params = [from||null, to||null];
    if (customer_id) { params.push(customer_id); where+=` AND t.customer_org_id=$${params.length}`; }
    if (agent_id)    { params.push(agent_id);    where+=` AND t.agent_id=$${params.length}`; }

    const { rows:[summary] } = await pool.query(`
      SELECT COUNT(*) AS responses,
        ROUND(AVG(cs.score)::numeric,1) AS avg_score,
        COUNT(CASE WHEN cs.score=10 THEN 1 END) AS thumbs_up,
        COUNT(CASE WHEN cs.score=5  THEN 1 END) AS thumbs_down,
        ROUND(COUNT(CASE WHEN cs.score=10 THEN 1 END)*100.0/NULLIF(COUNT(*),0)::numeric,1) AS csat_pct
      FROM csat_surveys cs
      JOIN tickets t ON t.id=cs.ticket_id
      ${where}`, params);

    const { rows: byPriority } = await pool.query(`
      SELECT t.priority, COUNT(*) AS count,
        ROUND(AVG(cs.score)::numeric,1) AS avg_score,
        ROUND(COUNT(CASE WHEN cs.score=10 THEN 1 END)*100.0/NULLIF(COUNT(*),0)::numeric,1) AS csat_pct
      FROM csat_surveys cs JOIN tickets t ON t.id=cs.ticket_id
      ${where} GROUP BY t.priority`, params);

    const { rows: recent } = await pool.query(`
      SELECT cs.*, t.ticket_number, t.subject, t.priority,
        c.name AS customer_org, a.name AS agent_name
      FROM csat_surveys cs JOIN tickets t ON t.id=cs.ticket_id
      LEFT JOIN customers c ON c.id=t.customer_org_id
      LEFT JOIN users a ON a.id=t.agent_id
      ${where} ORDER BY cs.responded_at DESC LIMIT 50`, params);

    // Pending surveys count
    const { rows:[pending] } = await pool.query(
      `SELECT COUNT(*) AS count FROM csat_surveys WHERE responded=false`);

    res.json({ success:true, data:{ summary, byPriority, recent, pending:Number(pending.count) }});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pending CSAT for current user (customer role)
router.get('/pending', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cs.*, t.ticket_number, t.subject, t.priority
       FROM csat_surveys cs JOIN tickets t ON t.id=cs.ticket_id
       WHERE cs.customer_id=$1 AND cs.responded=false
       ORDER BY cs.triggered_at ASC`, [req.user.id]);
    res.json({ success:true, data:rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
