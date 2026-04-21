const router = require('express').Router();
const pool   = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/', authenticate, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sla_policies ORDER BY priority');
  res.json({ success:true, data:rows });
});
router.put('/:priority', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { first_response_mins,resolution_mins } = req.body;
    const { rows:[p] } = await pool.query(
      `INSERT INTO sla_policies (priority,first_response_mins,resolution_mins) VALUES ($1,$2,$3) ON CONFLICT (priority) DO UPDATE SET first_response_mins=$2,resolution_mins=$3 RETURNING *`,
      [req.params.priority,first_response_mins,resolution_mins]);
    res.json({ success:true, data:p });
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.get('/customer', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT cs.*,c.name AS customer_name FROM customer_slas cs JOIN customers c ON c.id=cs.customer_id ORDER BY c.name,cs.priority`);
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.post('/customer', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { customer_id,priority,first_response_mins,resolution_mins,notes } = req.body;
    const { rows:[s] } = await pool.query(
      `INSERT INTO customer_slas (customer_id,priority,first_response_mins,resolution_mins,notes) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (customer_id,priority) DO UPDATE SET first_response_mins=$3,resolution_mins=$4,notes=$5 RETURNING *`,
      [customer_id,priority,first_response_mins,resolution_mins,notes||null]);
    res.status(201).json({ success:true, data:s });
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.delete('/customer/:id', authenticate, authorize('admin'), async (req, res) => {
  await pool.query('DELETE FROM customer_slas WHERE id=$1',[req.params.id]);
  res.json({ success:true });
});
router.get('/status', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.id,t.ticket_number,t.subject,t.priority,t.status,
        a.name AS agent_name,cu.name AS customer_org,
        COALESCE(cs.resolution_mins,sp.resolution_mins) AS resolution_mins,
        EXTRACT(EPOCH FROM (NOW()-t.created_at))/60 AS age_mins,
        ROUND((EXTRACT(EPOCH FROM (NOW()-t.created_at))/60/NULLIF(COALESCE(cs.resolution_mins,sp.resolution_mins),0)*100)::numeric,1) AS sla_pct
      FROM tickets t LEFT JOIN users a ON a.id=t.agent_id
      LEFT JOIN customers cu ON cu.id=t.customer_org_id
      LEFT JOIN sla_policies sp ON sp.priority=t.priority
      LEFT JOIN customer_slas cs ON cs.customer_id=t.customer_org_id AND cs.priority=t.priority
      WHERE t.status NOT IN ('Resolved','Closed')
      ORDER BY sla_pct DESC NULLS LAST LIMIT 100`);
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.get('/stage-config', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM stage_sla_config ORDER BY priority,stage');
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.put('/stage-config/:priority/:stage', authenticate, authorize('admin'), async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO stage_sla_config (priority,stage,max_mins) VALUES ($1,$2,$3) ON CONFLICT (priority,stage) DO UPDATE SET max_mins=$3`,
      [req.params.priority,req.params.stage,req.body.max_mins]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({error:e.message}); }
});
module.exports = router;
