const router = require('express').Router();
const pool   = require('../config/db');
const { authenticate } = require('../middleware/auth');

// ── Stage SLA Helpers ─────────────────────────────────────────────
async function logStageEntry(client, ticketId, stage, priority) {
  try {
    const { rows:[cfg] } = await client.query(
      'SELECT max_mins FROM stage_sla_config WHERE priority=$1 AND stage=$2',
      [priority, stage]);
    await client.query(
      `INSERT INTO ticket_stage_log (ticket_id,stage,entered_at,sla_max_mins)
       VALUES ($1,$2,NOW(),$3)`,
      [ticketId, stage, cfg?.max_mins || null]);
  } catch(e) {
    // Non-fatal — log error but don't break the transaction
    console.error('logStageEntry error:', e.message);
  }
}

async function closeStageEntry(client, ticketId, stage) {
  try {
    await client.query(
      `UPDATE ticket_stage_log
       SET exited_at = NOW(),
           breached = (sla_max_mins IS NOT NULL AND
             EXTRACT(EPOCH FROM (NOW()-entered_at))/60 > sla_max_mins)
       WHERE ticket_id=$1 AND stage=$2 AND exited_at IS NULL`,
      [ticketId, stage]);
  } catch(e) {
    console.error('closeStageEntry error:', e.message);
  }
}

async function createBreachAlertSafe(client, ticketId, alertType, stage) {
  try {
    // Use upsert with ON CONFLICT to handle duplicates safely
    await client.query(
      `INSERT INTO sla_breach_alerts (ticket_id, alert_type, stage)
       VALUES ($1, $2, $3)
       ON CONFLICT ON CONSTRAINT sla_breach_alerts_ticket_alert_stage_unique DO NOTHING`,
      [ticketId, alertType, stage]);
  } catch(e) {
    // If unique constraint doesn't exist yet, just insert
    try {
      await client.query(
        `INSERT INTO sla_breach_alerts (ticket_id, alert_type, stage) VALUES ($1,$2,$3)`,
        [ticketId, alertType, stage]);
    } catch {}
  }
}

// ── GET /tickets ──────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, priority, category, agent, customer_id, q } = req.query;
    let sql = `
      SELECT t.*,
        a.name AS agent_name,
        c.name AS customer_name,
        cu.name AS customer_org,
        COALESCE(cs_o.resolution_mins, sp.resolution_mins) AS effective_resolution_mins,
        ROUND(EXTRACT(EPOCH FROM (NOW()-t.created_at))/60::numeric,1) AS age_mins,
        CASE WHEN COALESCE(cs_o.resolution_mins, sp.resolution_mins) IS NOT NULL THEN
          ROUND((EXTRACT(EPOCH FROM (NOW()-t.created_at))/60 /
            NULLIF(COALESCE(cs_o.resolution_mins, sp.resolution_mins),0)*100)::numeric,1)
        END AS sla_pct,
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
    if (req.user.role === 'customer') {
      params.push(req.user.id); sql+=` AND t.customer_id=$${params.length}`;
    }
    sql += ' ORDER BY t.updated_at DESC LIMIT 500';
    const { rows } = await pool.query(sql, params);
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /tickets/:id ──────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { rows:[ticket] } = await pool.query(`
      SELECT t.*,
        a.name AS agent_name,
        c.name AS customer_name,
        cu.name AS customer_org,
        COALESCE(cs_o.resolution_mins, sp.resolution_mins) AS effective_resolution_mins,
        ROUND(EXTRACT(EPOCH FROM (NOW()-t.created_at))/60::numeric,1) AS age_mins,
        CASE WHEN COALESCE(cs_o.resolution_mins, sp.resolution_mins) IS NOT NULL THEN
          ROUND((EXTRACT(EPOCH FROM (NOW()-t.created_at))/60 /
            NULLIF(COALESCE(cs_o.resolution_mins, sp.resolution_mins),0)*100)::numeric,1)
        END AS sla_pct
      FROM tickets t
      LEFT JOIN users a ON a.id=t.agent_id
      LEFT JOIN users c ON c.id=t.customer_id
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

    // Stage SLA timeline — calculate duration in query (no stored computed column)
    const { rows: stageLog } = await pool.query(`
      SELECT
        tsl.*,
        sc.max_mins AS configured_max_mins,
        ROUND(CASE
          WHEN tsl.exited_at IS NOT NULL
            THEN EXTRACT(EPOCH FROM (tsl.exited_at - tsl.entered_at))/60
          ELSE EXTRACT(EPOCH FROM (NOW() - tsl.entered_at))/60
        END::numeric, 1) AS duration_mins
      FROM ticket_stage_log tsl
      LEFT JOIN stage_sla_config sc ON sc.priority=$2 AND sc.stage=tsl.stage
      WHERE tsl.ticket_id=$1
      ORDER BY tsl.entered_at ASC`,
      [req.params.id, ticket.priority]);

    // Attachments
    const { rows: attachments } = await pool.query(
      `SELECT * FROM ticket_attachments
       WHERE ticket_id=$1 AND deleted=false
       ORDER BY uploaded_at DESC`, [req.params.id]);

    // CSAT
    const { rows:[csat] } = await pool.query(
      `SELECT * FROM csat_surveys WHERE ticket_id=$1`, [req.params.id]);

    res.json({ success:true, data:{ ...ticket, thread, history, stageLog, attachments, csat:csat||null }});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /tickets/:id/valid-transitions ───────────────────────────
router.get('/:id/valid-transitions', authenticate, async (req, res) => {
  try {
    const { rows:[ticket] } = await pool.query(
      'SELECT status FROM tickets WHERE id=$1', [req.params.id]);
    if (!ticket) return res.status(404).json({ error:'Not found' });
    const { rows } = await pool.query(
      'SELECT to_status FROM workflow_transitions WHERE from_status=$1 ORDER BY to_status',
      [ticket.status]);
    res.json({ success:true, current:ticket.status, validNext:rows.map(r=>r.to_status) });
  } catch(e) {
    // If workflow_transitions table doesn't exist yet, return all statuses
    const all = ['New','Open','Assigned','In Progress','Pending','On Hold','Resolved','Closed','Escalated','Reopened'];
    res.json({ success:true, current:'Unknown', validNext: all });
  }
});

// ── POST /tickets ─────────────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { subject, description, priority='Medium', category,
            channel='Web Portal', agent_id, customer_org_id } = req.body;
    if (!subject) return res.status(400).json({ error:'Subject required' });

    const initialStatus = agent_id ? 'Assigned' : 'New';
    const { rows:[ticket] } = await client.query(`
      INSERT INTO tickets (subject,description,priority,category,channel,
        customer_id,agent_id,customer_org_id,status,incident_occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING *`,
      [subject,description,priority,category,channel,
       req.user.id, agent_id||null, customer_org_id||null, initialStatus]);

    await client.query(
      `INSERT INTO ticket_history (ticket_id,actor_id,field_changed,new_value)
       VALUES ($1,$2,'status',$3)`, [ticket.id, req.user.id, initialStatus]);

    await logStageEntry(client, ticket.id, initialStatus, priority);
    await client.query('COMMIT');
    res.status(201).json({ success:true, data:ticket });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ── POST /tickets/:id/status ──────────────────────────────────────
router.post('/:id/status', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { status } = req.body;
    if (!status) return res.status(400).json({ error:'status is required' });

    const { rows:[ticket] } = await client.query(
      'SELECT id, status, priority, agent_id, customer_org_id FROM tickets WHERE id=$1',
      [req.params.id]);
    if (!ticket) return res.status(404).json({ error:'Not found' });

    // Same status — no-op
    if (ticket.status === status) {
      await client.query('ROLLBACK');
      return res.json({ success:true, status, previous:ticket.status, message:'No change' });
    }

    // VALIDATE TRANSITION against workflow rules
    let transitionAllowed = false;
    try {
      const { rows:[allowed] } = await client.query(
        'SELECT 1 FROM workflow_transitions WHERE from_status=$1 AND to_status=$2',
        [ticket.status, status]);
      transitionAllowed = !!allowed;
    } catch {
      // If table doesn't exist, allow all transitions
      transitionAllowed = true;
    }

    if (!transitionAllowed) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Invalid transition: "${ticket.status}" → "${status}" is not permitted. Check Help → Workflow for allowed transitions.`,
        current: ticket.status,
        attempted: status
      });
    }

    // Close current stage entry
    await closeStageEntry(client, req.params.id, ticket.status);

    // Build update fields
    const setClauses = ['status=$1', 'updated_at=NOW()'];
    const setParams = [status];

    if (status === 'Resolved') {
      setClauses.push('resolved_at=NOW()');
    }
    if (status === 'Closed') {
      setClauses.push('closed_at=NOW()');
    }
    if (status === 'Escalated') {
      setClauses.push('escalation_count=escalation_count+1');
      setClauses.push('is_ftr=false');
    }
    if (status === 'Reopened') {
      setClauses.push('reopened_count=reopened_count+1');
      setClauses.push('is_ftr=false');
      setClauses.push('resolved_at=NULL');
    }
    if (['Assigned','In Progress'].includes(status)) {
      setClauses.push('first_response_at=COALESCE(first_response_at,NOW())');
    }

    setParams.push(req.params.id);
    await client.query(
      `UPDATE tickets SET ${setClauses.join(', ')} WHERE id=$${setParams.length}`,
      setParams);

    // History entry
    await client.query(
      `INSERT INTO ticket_history (ticket_id,actor_id,field_changed,old_value,new_value)
       VALUES ($1,$2,'status',$3,$4)`,
      [req.params.id, req.user.id, ticket.status, status]);

    // Start new stage entry
    await logStageEntry(client, req.params.id, status, ticket.priority);

    // Escalation breach alert
    if (status === 'Escalated') {
      await createBreachAlertSafe(client, req.params.id, 'breach', 'Escalated');
    }

    // Check overall SLA breach
    try {
      const { rows:[slaCheck] } = await client.query(`
        SELECT CASE WHEN COALESCE(cs.resolution_mins, sp.resolution_mins) IS NOT NULL THEN
          ROUND((EXTRACT(EPOCH FROM (NOW()-t.created_at))/60 /
            NULLIF(COALESCE(cs.resolution_mins, sp.resolution_mins),0)*100)::numeric,1)
        END AS pct
        FROM tickets t
        LEFT JOIN sla_policies sp ON sp.priority=t.priority
        LEFT JOIN customer_slas cs ON cs.customer_id=t.customer_org_id AND cs.priority=t.priority
        WHERE t.id=$1`, [req.params.id]);
      if (slaCheck && Number(slaCheck.pct) >= 90) {
        await createBreachAlertSafe(client, req.params.id, 'breach', 'overall');
      }
    } catch {}

    await client.query('COMMIT');
    res.json({ success:true, status, previous:ticket.status });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ── POST /tickets/:id/assign ──────────────────────────────────────
router.post('/:id/assign', authenticate, async (req, res) => {
  try {
    const { agent_id } = req.body;
    await pool.query(`
      UPDATE tickets SET
        agent_id=$1,
        status=CASE WHEN status='New' THEN 'Assigned' ELSE status END,
        first_response_at=COALESCE(first_response_at,NOW()),
        updated_at=NOW()
      WHERE id=$2`, [agent_id, req.params.id]);
    await pool.query(
      `INSERT INTO ticket_history (ticket_id,actor_id,field_changed,new_value)
       VALUES ($1,$2,'agent_id',$3)`, [req.params.id, req.user.id, agent_id]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /tickets/:id ──────────────────────────────────────────────
router.put('/:id', authenticate, async (req, res) => {
  try {
    const allowed = ['subject','description','priority','category','tags','customer_org_id'];
    const updates=[]; const params=[];
    for (const [k,v] of Object.entries(req.body)) {
      if (allowed.includes(k)) { params.push(v); updates.push(`${k}=$${params.length}`); }
    }
    if (!updates.length) return res.status(400).json({ error:'Nothing to update' });
    params.push(req.params.id);
    await pool.query(
      `UPDATE tickets SET ${updates.join(',')}, updated_at=NOW() WHERE id=$${params.length}`,
      params);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /tickets/:id/comments ────────────────────────────────────
router.post('/:id/comments', authenticate, async (req, res) => {
  try {
    const { content, type='public' } = req.body;
    if (!content) return res.status(400).json({ error:'Content required' });
    const { rows:[comment] } = await pool.query(
      `INSERT INTO ticket_threads (ticket_id,author_id,type,content)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, req.user.id, type, content]);
    await pool.query(
      `UPDATE tickets SET updated_at=NOW()${type==='public'?', first_response_at=COALESCE(first_response_at,NOW())':''} WHERE id=$1`,
      [req.params.id]);
    res.status(201).json({ success:true, data:comment });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
