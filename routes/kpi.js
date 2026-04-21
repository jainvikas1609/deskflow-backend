const router = require('express').Router();
const pool   = require('../config/db');
const { authenticate } = require('../middleware/auth');

router.get('/summary', authenticate, async (req, res) => {
  try {
    const { from, to, priority, customer_id, agent_id } = req.query;
    let where = `WHERE t.created_at >= COALESCE($1::timestamptz, NOW()-INTERVAL '30 days')
                   AND t.created_at <= COALESCE($2::timestamptz, NOW())`;
    const params = [from||null, to||null];
    if (priority)    { params.push(priority);    where+=` AND t.priority=$${params.length}`; }
    if (customer_id) { params.push(customer_id); where+=` AND t.customer_org_id=$${params.length}`; }
    if (agent_id)    { params.push(agent_id);    where+=` AND t.agent_id=$${params.length}`; }

    const { rows:[stats] } = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(CASE WHEN t.status NOT IN ('Resolved','Closed') THEN 1 END) AS open,
        COUNT(CASE WHEN t.status='Resolved' THEN 1 END) AS resolved,
        COUNT(CASE WHEN t.status='Escalated' THEN 1 END) AS escalated,
        COUNT(CASE WHEN t.status IN ('Resolved','Closed') AND t.is_ftr=true THEN 1 END) AS ftr_count,
        COUNT(CASE WHEN t.status IN ('Resolved','Closed') THEN 1 END) AS closed_count,
        COUNT(CASE WHEN t.reopened_count > 0 THEN 1 END) AS repeat_count,
        COUNT(CASE WHEN t.escalation_count > 0 THEN 1 END) AS escalation_count,
        -- MTTD: avg mins from incident_occurred_at to created_at (defaults to 0 if same)
        ROUND(AVG(EXTRACT(EPOCH FROM (t.created_at - COALESCE(t.incident_occurred_at, t.created_at)))/60)::numeric,1) AS avg_mttd_mins,
        -- MTTR: avg mins from created_at to resolved_at
        ROUND(AVG(CASE WHEN t.resolved_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))/60 END)::numeric,1) AS avg_mttr_mins,
        -- First response time avg
        ROUND(AVG(CASE WHEN t.first_response_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (t.first_response_at - t.created_at))/60 END)::numeric,1) AS avg_first_response_mins,
        -- SLA breach rate
        COUNT(CASE WHEN t.resolved_at IS NOT NULL
          AND EXTRACT(EPOCH FROM (t.resolved_at-t.created_at))/60 >
          COALESCE(cs.resolution_mins, sp.resolution_mins) THEN 1 END) AS breach_count
      FROM tickets t
      LEFT JOIN sla_policies sp ON sp.priority=t.priority
      LEFT JOIN customer_slas cs ON cs.customer_id=t.customer_org_id AND cs.priority=t.priority
      ${where}`, params);

    const total = Number(stats.total)||0;
    const closedCount = Number(stats.closed_count)||0;
    const ftr = closedCount>0 ? Math.round((Number(stats.ftr_count)/closedCount)*100) : 0;
    const escalationRate = total>0 ? Math.round((Number(stats.escalation_count)/total)*100) : 0;
    const repeatRate = total>0 ? Math.round((Number(stats.repeat_count)/total)*100) : 0;
    const breachRate = closedCount>0 ? Math.round((Number(stats.breach_count)/closedCount)*100) : 0;

    res.json({ success:true, data:{
      total, open:Number(stats.open), resolved:Number(stats.resolved),
      escalated:Number(stats.escalated),
      mttd_mins: Number(stats.avg_mttd_mins)||0,
      mttr_mins: Number(stats.avg_mttr_mins)||0,
      first_response_mins: Number(stats.avg_first_response_mins)||0,
      ftr_pct: ftr,
      escalation_rate_pct: escalationRate,
      repeat_rate_pct: repeatRate,
      breach_rate_pct: breachRate
    }});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/by-severity', authenticate, async (req, res) => {
  try {
    const { from, to } = req.query;
    const { rows } = await pool.query(`
      SELECT t.priority,
        COUNT(*) AS total,
        COUNT(CASE WHEN t.status NOT IN ('Resolved','Closed') THEN 1 END) AS open,
        ROUND(AVG(CASE WHEN t.resolved_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (t.resolved_at-t.created_at))/60 END)::numeric,1) AS avg_mttr_mins,
        COUNT(CASE WHEN t.escalation_count>0 THEN 1 END) AS escalated,
        ROUND(COUNT(CASE WHEN t.is_ftr=true AND t.status IN ('Resolved','Closed') THEN 1 END)*100.0/
          NULLIF(COUNT(CASE WHEN t.status IN ('Resolved','Closed') THEN 1 END),0)::numeric,1) AS ftr_pct
      FROM tickets t
      WHERE t.created_at >= COALESCE($1::timestamptz, NOW()-INTERVAL '30 days')
        AND t.created_at <= COALESCE($2::timestamptz, NOW())
      GROUP BY t.priority
      ORDER BY CASE t.priority WHEN 'Urgent' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 ELSE 4 END`,
      [from||null, to||null]);
    res.json({ success:true, data:rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/by-agent', authenticate, async (req, res) => {
  try {
    const { from, to } = req.query;
    const { rows } = await pool.query(`
      SELECT u.id, u.name,
        COUNT(t.id) AS total,
        COUNT(CASE WHEN t.status NOT IN ('Resolved','Closed') THEN 1 END) AS open,
        COUNT(CASE WHEN t.status IN ('Resolved','Closed') THEN 1 END) AS closed,
        ROUND(AVG(CASE WHEN t.resolved_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (t.resolved_at-t.created_at))/60 END)::numeric,1) AS avg_mttr_mins,
        ROUND(COUNT(CASE WHEN t.is_ftr=true AND t.status IN ('Resolved','Closed') THEN 1 END)*100.0/
          NULLIF(COUNT(CASE WHEN t.status IN ('Resolved','Closed') THEN 1 END),0)::numeric,1) AS ftr_pct,
        COUNT(CASE WHEN t.escalation_count>0 THEN 1 END) AS escalated
      FROM users u LEFT JOIN tickets t ON t.agent_id=u.id
        AND t.created_at >= COALESCE($1::timestamptz, NOW()-INTERVAL '30 days')
        AND t.created_at <= COALESCE($2::timestamptz, NOW())
      WHERE u.role IN ('agent','supervisor') AND u.active=true
      GROUP BY u.id,u.name ORDER BY total DESC`, [from||null, to||null]);
    res.json({ success:true, data:rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/by-day', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DATE_TRUNC('day',created_at) AS date,
        TO_CHAR(created_at,'DD Mon') AS label,
        COUNT(*) AS total,
        COUNT(CASE WHEN priority='Urgent' THEN 1 END) AS urgent,
        COUNT(CASE WHEN priority='High' THEN 1 END) AS high
      FROM tickets
      WHERE created_at >= NOW()-INTERVAL '30 days'
      GROUP BY DATE_TRUNC('day',created_at), TO_CHAR(created_at,'DD Mon')
      ORDER BY date`);
    res.json({ success:true, data:rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/stage-analysis', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT tsl.stage,
        COUNT(*) AS total_entries,
        COUNT(CASE WHEN tsl.breached THEN 1 END) AS breaches,
        ROUND(AVG(CASE WHEN tsl.exited_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (tsl.exited_at-tsl.entered_at))/60 END)::numeric,1) AS avg_mins,
        ROUND(MAX(CASE WHEN tsl.exited_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (tsl.exited_at-tsl.entered_at))/60 END)::numeric,1) AS max_mins,
        MIN(tsl.sla_max_mins) AS sla_max_mins
      FROM ticket_stage_log tsl
      WHERE tsl.entered_at >= NOW()-INTERVAL '30 days'
      GROUP BY tsl.stage
      ORDER BY avg_mins DESC NULLS LAST`);
    res.json({ success:true, data:rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
