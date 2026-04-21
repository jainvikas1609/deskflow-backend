const router = require('express').Router();
const pool   = require('../config/db');
const { authenticate } = require('../middleware/auth');

// ── Helpers ──────────────────────────────────────────────────────
async function logStageEntry(client, ticketId, stage, priority) {
  const { rows: [cfg] } = await client.query(
    'SELECT max_mins FROM stage_sla_config WHERE priority=$1 AND stage=$2', [priority, stage]);
  await client.query(
    `INSERT INTO ticket_stage_log (ticket_id,stage,entered_at,sla_max_mins)
     VALUES ($1,$2,NOW(),$3)`, [ticketId, stage, cfg?.max_mins || null]);
}

async function closeStageEntry(client, ticketId, stage) {
  await client.query(
    `UPDATE ticket_stage_log SET exited_at=NOW(),
      breached = (sla_max_mins IS NOT NULL AND
        EXTRACT(EPOCH FROM (NOW()-entered_at))/60 > sla_max_mins)
     WHERE ticket_id=$1 AND stage=$2 AND exited_at IS NULL`, [ticketId, stage]);
}

async function checkAndCreateBreachAlert(client, ticketId, stage, priority) {
  // Check if stage SLA is breached
  const { rows } = await client.query(
    `SELECT tsl.id FROM ticket_stage_log tsl
     JOIN stage_sla_config sc ON sc.priority=$1 AND sc.stage=$2
     WHERE tsl.ticket_id=$3 AND tsl.stage=$2 AND tsl.exited_at IS NOT NULL
     AND EXTRACT(EPOCH FROM (tsl.exited_at-tsl.entered_at))/60 > sc.max_mins`, [priority, stage, ticketId]);
  if (rows.length > 0) {
    await client.query(
      `INSERT INTO sla_breach_alerts (ticket_id,alert_type,stage) VALUES ($1,'stage_breach',$2)
       ON CONFLICT DO NOTHING`, [ticketId, stage]);
  }
}

// ── ROUTES ───────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, priority, category, agent, customer_id, q } = req.query;
    let sql = `SELECT t.*,
      a.name AS agent_name, c.name AS customer_name, cu.name AS customer_org,
      sp.first_response_mins, sp.resolution_mins,
      COALESCE(cs_o.first_response_mins, sp.first_response_mins) AS effective_response_mins,
      COALESCE(cs_o.resolution_mins, sp.resolution_mins) AS effective_resolution_mins,
      EXTRACT(EPOCH FROM (NOW()-t.created_at))/60 AS age_mins,
      ROUND((EXTRACT(EPOCH FROM (NOW()-t.created_at))/60 /
        NULLIF(COALESCE(cs_o.resolution_mins, sp.resolution_mins),0)*100)::numeric,1) AS sla_pct,
      (SELECT COUNT(*) FROM ticket_attachments ta WHERE ta.ticket_id=t.id AND ta.deleted=false) AS attachment_count,
      (SELECT score FROM csat_surveys WHERE ticket_id=t.id) AS csat_score
      FROM tickets t
      LEFT JOIN users a ON a.id=t.agent_id
      LEFT JOIN users c ON c.id=t.customer_id
      LEFT JOIN customers cu ON cu.id=t.customer_org_id
      LEFT JOIN sla_policies sp ON sp.priority=t.priority
      LEFT JOIN customer_slas cs_o ON cs_o.customer_id=t.customer_org_id AND cs_o.priority=t.priority
      WHERE 1=1`;
    const params = [];
    if (status)      { params.push(status);      sql+=` AND t.status=$${params.length}`; }
    if (priority)    { params.push(priority);    sql+=` AND t.priority=$${params.length}`; }
    if (category)    { params.push(category);    sql+=` AND t.category=$${params.length}`; }
    if (agent)       { params.push(agent);       sql+=` AND t.agent_id=$${params.length}`; }
    if (customer_id) { params.push(customer_id); sql+=` AND t.customer_org_id=$${params.length}`; }
    if (q)           { params.push(`%${q}%`);    sql+=` AND (t.subject ILIKE $${params.length} OR t.ticket_number ILIKE $${params.length})`; }
    if (req.user.role === 'customer') { params.push(req.user.id); sql+=` AND t.customer_id=$${params.length}`; }
    sql += ' ORDER BY t.updated_at DESC LIMIT 500';
    const { rows } = await pool.query(sql, params);
    res.json({ success:true, data:rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', authenticate, async (req, res) => {
  try {
    const { rows:[ticket] } = await pool.query(
      `SELECT t.*, a.name AS agent_name, c.name AS customer_name, cu.name AS customer_org,
        sp.first_response_mins, sp.resolution_mins,
        COALESCE(cs_o.resolution_mins, sp.resolution_mins) AS effective_resolution_mins,
        EXTRACT(EPOCH FROM (NOW()-t.created_at))/60 AS age_mins,
        ROUND((EXTRACT(EPOCH FROM (NOW()-t.created_at))/60 /
          NULLIF(COALESCE(cs_o.resolution_mins, sp.resolution_mins),0)*100)::numeric,1) AS sla_pct
       FROM tickets t
       LEFT JOIN users a ON a.id=t.agent_id LEFT JOIN users c ON c.id=t.customer_id
       LEFT JOIN customers cu ON cu.id=t.customer_org_id
       LEFT JOIN sla_policies sp ON sp.priority=t.priority
       LEFT JOIN customer_slas cs_o ON cs_o.customer_id=t.customer_org_id AND cs_o.priority=t.priority
       WHERE t.id=$1`, [req.params.id]);
    if (!ticket) return res.status(404).json({ error:'Not found' });

    const { rows: thread } = await pool.query(
      `SELECT th.*, u.name AS author_name FROM ticket_threads th
       LEFT JOIN users u ON u.id=th.author_id
       WHERE th.ticket_id=$1 ORDER BY th.created_at ASC`, [req.params.id]);

    const { rows: history } = await pool.query(
      `SELECT h.*, u.name AS actor_name FROM ticket_history h
       LEFT JOIN users u ON u.id=h.actor_id
       WHERE h.ticket_id=$1 ORDER BY h.changed_at ASC`, [req.params.id]);

    // Stage SLA timeline
    const { rows: stageLog } = await pool.query(
      `SELECT tsl.*, sc.max_mins AS configured_max_mins,
        CASE WHEN tsl.exited_at IS NOT NULL
          THEN ROUND(EXTRACT(EPOCH FROM (tsl.exited_at-tsl.entered_at))/60::numeric,1)
          ELSE ROUND(EXTRACT(EPOCH FROM (NOW()-tsl.entered_at))/60::numeric,1) END AS duration_mins
       FROM ticket_stage_log tsl
       LEFT JOIN stage_sla_config sc ON sc.priority=$2 AND sc.stage=tsl.stage
       WHERE tsl.ticket_id=$1 ORDER BY tsl.entered_at ASC`,
      [req.params.id, ticket.priority]);

    // Attachments
    const { rows: attachments } = await pool.query(
      `SELECT * FROM ticket_attachments WHERE ticket_id=$1 AND deleted=false ORDER BY uploaded_at DESC`,
      [req.params.id]);

    // CSAT
    const { rows: [csat] } = await pool.query(
      `SELECT * FROM csat_surveys WHERE ticket_id=$1`, [req.params.id]);

    res.json({ success:true, data:{ ...ticket, thread, history, stageLog, attachments, csat:csat||null }});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { subject, description, priority='Medium', category, channel='Web Portal',
            agent_id, customer_org_id } = req.body;
    if (!subject) return res.status(400).json({ error:'Subject required' });
    const { rows:[ticket] } = await client.query(
      `INSERT INTO tickets (subject,description,priority,category,channel,
        customer_id,agent_id,customer_org_id,status,incident_occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING *`,
      [subject,description,priority,category,channel,
       req.user.id, agent_id||null, customer_org_id||null, agent_id?'Assigned':'New']);
    await client.query(
      `INSERT INTO ticket_history (ticket_id,actor_id,field_changed,new_value)
       VALUES ($1,$2,'status',$3)`, [ticket.id, req.user.id, ticket.status]);
    await logStageEntry(client, ticket.id, ticket.status, priority);
    await client.query('COMMIT');
    res.status(201).json({ success:true, data:ticket });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

router.post('/:id/status', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { status } = req.body;
    const { rows:[ticket] } = await client.query(
      'SELECT status, priority, agent_id FROM tickets WHERE id=$1', [req.params.id]);
    if (!ticket) return res.status(404).json({ error:'Not found' });

    // VALIDATE TRANSITION
    const { rows:[allowed] } = await client.query(
      'SELECT 1 FROM workflow_transitions WHERE from_status=$1 AND to_status=$2',
      [ticket.status, status]);
    if (!allowed) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Invalid transition: "${ticket.status}" → "${status}" is not permitted by workflow rules.`,
        current: ticket.status, attempted: status
      });
    }

    // Close current stage log entry
    await closeStageEntry(client, req.params.id, ticket.status);
    await checkAndCreateBreachAlert(client, req.params.id, ticket.status, ticket.priority);

    // Extra fields based on new status
    const extras = [];
    const extraParams = [];
    if (status === 'Resolved')  { extras.push('resolved_at=NOW()'); ticket.is_ftr_update = true; }
    if (status === 'Closed')    { extras.push('closed_at=NOW()'); }
    if (status === 'Escalated') {
      extras.push('escalation_count=escalation_count+1');
      extras.push('is_ftr=false');
      // Create breach alert for escalation
      await client.query(
        `INSERT INTO sla_breach_alerts (ticket_id,alert_type,stage) VALUES ($1,'breach','Escalated')`,
        [req.params.id]);
    }
    if (status === 'Reopened')  {
      extras.push('reopened_count=reopened_count+1');
      extras.push('is_ftr=false');
      extras.push('resolved_at=NULL');
    }

    const extraSql = extras.length ? ', ' + extras.join(', ') : '';
    await client.query(
      `UPDATE tickets SET status=$1, updated_at=NOW()${extraSql} WHERE id=$2`,
      [status, req.params.id]);

    // Set first_response_at on first reply-like status
    if (['Assigned','In Progress'].includes(status)) {
      await client.query(
        `UPDATE tickets SET first_response_at=COALESCE(first_response_at,NOW()) WHERE id=$1`,
        [req.params.id]);
    }

    await client.query(
      `INSERT INTO ticket_history (ticket_id,actor_id,field_changed,old_value,new_value)
       VALUES ($1,$2,'status',$3,$4)`, [req.params.id, req.user.id, ticket.status, status]);

    // Start new stage log
    await logStageEntry(client, req.params.id, status, ticket.priority);

    // Check overall SLA breach
    const { rows:[slaCheck] } = await client.query(
      `SELECT ROUND((EXTRACT(EPOCH FROM (NOW()-t.created_at))/60 /
          NULLIF(COALESCE(cs.resolution_mins, sp.resolution_mins),0)*100)::numeric,1) AS pct
       FROM tickets t
       LEFT JOIN sla_policies sp ON sp.priority=t.priority
       LEFT JOIN customer_slas cs ON cs.customer_id=t.customer_org_id AND cs.priority=t.priority
       WHERE t.id=$1`, [req.params.id]);
    if (slaCheck && Number(slaCheck.pct) >= 90) {
      await client.query(
        `INSERT INTO sla_breach_alerts (ticket_id,alert_type) VALUES ($1,'breach')
         ON CONFLICT DO NOTHING`, [req.params.id]);
    }

    await client.query('COMMIT');
    res.json({ success:true, status, previous:ticket.status });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

router.post('/:id/assign', authenticate, async (req, res) => {
  try {
    const { agent_id } = req.body;
    const { rows:[old] } = await pool.query('SELECT agent_id,status FROM tickets WHERE id=$1', [req.params.id]);
    await pool.query(
      `UPDATE tickets SET agent_id=$1,
        status=CASE WHEN status='New' THEN 'Assigned' ELSE status END,
        first_response_at=COALESCE(first_response_at,NOW()), updated_at=NOW()
       WHERE id=$2`, [agent_id, req.params.id]);
    await pool.query(
      `INSERT INTO ticket_history (ticket_id,actor_id,field_changed,old_value,new_value)
       VALUES ($1,$2,'agent_id',$3,$4)`, [req.params.id, req.user.id, old.agent_id, agent_id]);
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', authenticate, async (req, res) => {
  try {
    const allowed = ['subject','description','priority','category','tags','customer_org_id'];
    const updates=[]; const params=[];
    for (const [k,v] of Object.entries(req.body)) {
      if (allowed.includes(k)) { params.push(v); updates.push(`${k}=$${params.length}`); }
    }
    if (!updates.length) return res.status(400).json({ error:'Nothing to update' });
    params.push(req.params.id);
    await pool.query(`UPDATE tickets SET ${updates.join(',')},updated_at=NOW() WHERE id=$${params.length}`, params);
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/comments', authenticate, async (req, res) => {
  try {
    const { content, type='public' } = req.body;
    if (!content) return res.status(400).json({ error:'Content required' });
    const { rows:[comment] } = await pool.query(
      `INSERT INTO ticket_threads (ticket_id,author_id,type,content)
       VALUES ($1,$2,$3,$4) RETURNING *`, [req.params.id, req.user.id, type, content]);
    await pool.query('UPDATE tickets SET updated_at=NOW() WHERE id=$1', [req.params.id]);
    if (type === 'public') {
      await pool.query(
        `UPDATE tickets SET first_response_at=COALESCE(first_response_at,NOW()) WHERE id=$1`,
        [req.params.id]);
    }
    res.status(201).json({ success:true, data:comment });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get valid transitions for a status
router.get('/:id/valid-transitions', authenticate, async (req, res) => {
  try {
    const { rows:[ticket] } = await pool.query('SELECT status FROM tickets WHERE id=$1', [req.params.id]);
    if (!ticket) return res.status(404).json({ error:'Not found' });
    const { rows } = await pool.query(
      'SELECT to_status FROM workflow_transitions WHERE from_status=$1 ORDER BY to_status',
      [ticket.status]);
    res.json({ success:true, current:ticket.status, validNext:rows.map(r=>r.to_status) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
