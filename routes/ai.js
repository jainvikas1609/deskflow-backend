const router = require('express').Router();
const pool   = require('../config/db');
const { authenticate } = require('../middleware/auth');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';

async function callClaude(prompt, maxTokens = 800) {
  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      messages: [{ role:'user', content: prompt }]
    })
  });
  const data = await res.json();
  return data.content?.[0]?.text || 'No response';
}

// Auto RCA suggestion using past incident correlation
router.post('/rca/:ticketId', authenticate, async (req, res) => {
  try {
    const { rows:[ticket] } = await pool.query(
      `SELECT t.*, a.name AS agent_name, cu.name AS customer_org
       FROM tickets t LEFT JOIN users a ON a.id=t.agent_id
       LEFT JOIN customers cu ON cu.id=t.customer_org_id
       WHERE t.id=$1`, [req.params.ticketId]);
    if (!ticket) return res.status(404).json({ error:'Not found' });

    // Get similar past resolved tickets
    const { rows: similar } = await pool.query(
      `SELECT t.ticket_number, t.subject, t.description, t.category, t.priority,
        th.content AS resolution
       FROM tickets t
       LEFT JOIN ticket_threads th ON th.ticket_id=t.id AND th.type='internal'
       WHERE t.status IN ('Resolved','Closed')
         AND t.category=$1 AND t.id != $2
       ORDER BY t.resolved_at DESC LIMIT 5`,
      [ticket.category, req.params.ticketId]);

    const pastContext = similar.map(s =>
      `Ticket ${s.ticket_number}: ${s.subject}\nResolution: ${s.resolution||'Not documented'}`
    ).join('\n\n');

    const prompt = `You are a technical support RCA analyst. Analyse this ticket and suggest root cause analysis.

CURRENT TICKET:
Number: ${ticket.ticket_number}
Subject: ${ticket.subject}
Category: ${ticket.category}
Priority: ${ticket.priority}
Description: ${ticket.description || 'Not provided'}
Customer: ${ticket.customer_org || 'Unknown'}

SIMILAR PAST INCIDENTS (resolved):
${pastContext || 'No similar past incidents found'}

Provide a structured RCA with:
1. Most likely root cause (2-3 sentences)
2. Contributing factors (bullet points)
3. Recommended immediate actions (numbered list)
4. Prevention recommendations (bullet points)
5. Similar incident pattern (if applicable)

Keep response concise and actionable.`;

    const rca = await callClaude(prompt, 1000);
    res.json({ success:true, data:{ rca, similarTickets:similar.map(s=>s.ticket_number) }});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Predictive SLA breach detection
router.get('/sla-prediction', authenticate, async (req, res) => {
  try {
    const { rows: atRisk } = await pool.query(`
      SELECT t.id, t.ticket_number, t.subject, t.priority, t.status,
        t.agent_id, a.name AS agent_name, cu.name AS customer_org,
        COALESCE(cs.resolution_mins, sp.resolution_mins) AS resolution_mins,
        EXTRACT(EPOCH FROM (NOW()-t.created_at))/60 AS age_mins,
        ROUND((EXTRACT(EPOCH FROM (NOW()-t.created_at))/60 /
          NULLIF(COALESCE(cs.resolution_mins, sp.resolution_mins),0)*100)::numeric,1) AS sla_pct,
        -- Stage duration vs stage SLA
        tsl.stage AS current_stage,
        EXTRACT(EPOCH FROM (NOW()-tsl.entered_at))/60 AS stage_age_mins,
        sc.max_mins AS stage_max_mins
      FROM tickets t
      LEFT JOIN users a ON a.id=t.agent_id
      LEFT JOIN customers cu ON cu.id=t.customer_org_id
      LEFT JOIN sla_policies sp ON sp.priority=t.priority
      LEFT JOIN customer_slas cs ON cs.customer_id=t.customer_org_id AND cs.priority=t.priority
      LEFT JOIN ticket_stage_log tsl ON tsl.ticket_id=t.id AND tsl.exited_at IS NULL
      LEFT JOIN stage_sla_config sc ON sc.priority=t.priority AND sc.stage=tsl.stage
      WHERE t.status NOT IN ('Resolved','Closed')
      ORDER BY sla_pct DESC NULLS LAST`);

    // Classify risk
    const predictions = atRisk.map(t => {
      const pct = Number(t.sla_pct)||0;
      const stagePct = t.stage_max_mins ? (Number(t.stage_age_mins)/t.stage_max_mins*100) : 0;
      let risk = 'low';
      let prediction = 'On track';
      let timeToBreachMins = null;
      if (pct >= 90) { risk='breached'; prediction='SLA BREACHED'; }
      else if (pct >= 70) {
        risk='high';
        const remaining = (Number(t.resolution_mins) * (1-pct/100));
        timeToBreachMins = Math.round(remaining);
        prediction = `Breach in ~${Math.round(remaining/60*10)/10}h`;
      } else if (pct >= 50 || stagePct >= 80) {
        risk='medium'; prediction='Monitor closely';
      }
      return { ...t, risk, prediction, timeToBreachMins, stagePct:Math.round(stagePct) };
    });

    res.json({ success:true, data:predictions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Convert resolved ticket to KB article (1-click)
router.post('/to-kb/:ticketId', authenticate, async (req, res) => {
  try {
    const { rows:[ticket] } = await pool.query(
      `SELECT t.*, a.name AS agent_name FROM tickets t
       LEFT JOIN users a ON a.id=t.agent_id WHERE t.id=$1`, [req.params.ticketId]);
    if (!ticket) return res.status(404).json({ error:'Not found' });
    if (!['Resolved','Closed'].includes(ticket.status))
      return res.status(400).json({ error:'Ticket must be Resolved or Closed' });

    const { rows: threads } = await pool.query(
      `SELECT content, type FROM ticket_threads WHERE ticket_id=$1 ORDER BY created_at ASC`,
      [req.params.ticketId]);

    const resolution = threads.filter(t=>t.type==='internal').map(t=>t.content).join('\n');
    const publicNotes = threads.filter(t=>t.type==='public').map(t=>t.content).join('\n');

    const prompt = `Convert this resolved support ticket into a clear, reusable knowledge base article.

TICKET:
Number: ${ticket.ticket_number}
Subject: ${ticket.subject}
Category: ${ticket.category}
Description: ${ticket.description || 'Not provided'}

RESOLUTION NOTES:
${resolution || publicNotes || 'No resolution notes found'}

Write a KB article with:
- Title: Clear, searchable title
- Problem: What the issue was (2-3 sentences)
- Root Cause: Why it happened (2-3 sentences)
- Solution: Step-by-step resolution (numbered list)
- Prevention: How to avoid recurrence (bullet points)

Format as plain text, no markdown headers.`;

    const generated = await callClaude(prompt, 1200);

    // Parse out title (first line) and content (rest)
    const lines = generated.split('\n').filter(l=>l.trim());
    const title = lines[0].replace(/^Title:\s*/i,'') || ticket.subject;
    const content = lines.slice(1).join('\n');

    const { rows:[article] } = await pool.query(
      `INSERT INTO kb_articles (title,content,category,author_id,published,source_ticket_id)
       VALUES ($1,$2,$3,$4,false,$5) RETURNING *`,
      [title, content, ticket.category, req.user.id, ticket.id]);

    res.status(201).json({ success:true, data:article, message:'KB article created as draft. Review and publish from Knowledge Base.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// AI Copilot tools reference
router.get('/tools', authenticate, async (req, res) => {
  res.json({ success:true, data:[
    { name:'Claude AI', description:'General AI assistant for analysis, writing, summarisation', url:'https://claude.ai', free:true, type:'LLM' },
    { name:'ChatGPT', description:'OpenAI assistant for drafting, analysis, customer responses', url:'https://chat.openai.com', free:true, type:'LLM' },
    { name:'Gemini', description:'Google AI for search-enhanced assistance and summarisation', url:'https://gemini.google.com', free:true, type:'LLM' },
    { name:'Perplexity', description:'AI search engine for real-time technical research', url:'https://www.perplexity.ai', free:true, type:'Search+LLM' },
    { name:'Notion AI', description:'AI writing assistant for documentation and KB articles', url:'https://www.notion.so/product/ai', free:false, type:'Writing' },
    { name:'Tidio', description:'AI chatbot for customer-facing support automation', url:'https://www.tidio.com', free:true, type:'Chatbot' },
    { name:'Botpress', description:'Open-source AI chatbot builder for custom support bots', url:'https://botpress.com', free:true, type:'Chatbot' },
    { name:'Copilot Studio', description:'Microsoft AI for enterprise workflow automation', url:'https://www.microsoft.com/en-us/microsoft-copilot/microsoft-copilot-studio', free:false, type:'Enterprise' }
  ]});
});

module.exports = router;
