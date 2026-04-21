const router = require('express').Router();
const pool   = require('../config/db');
const { authenticate } = require('../middleware/auth');

// Supabase storage via REST API
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const BUCKET         = 'ticket-attachments';

async function supabaseUpload(path, fileBuffer, contentType) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'true'
    },
    body: fileBuffer
  });
  if (!res.ok) throw new Error('Upload failed: ' + await res.text());
  return path;
}

async function supabaseDelete(path) {
  await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
}

async function supabaseSignedUrl(path) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ expiresIn: 3600 })
  });
  const data = await res.json();
  return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
}

// Upload attachment (base64)
router.post('/:ticketId', authenticate, async (req, res) => {
  try {
    const { fileName, fileType, fileSize, fileData } = req.body;
    if (!fileName || !fileData) return res.status(400).json({ error:'fileName and fileData required' });
    if (fileSize > 10 * 1024 * 1024) return res.status(400).json({ error:'File too large (max 10MB)' });

    // Check attachment count per ticket
    const { rows:[cnt] } = await pool.query(
      'SELECT COUNT(*) FROM ticket_attachments WHERE ticket_id=$1 AND deleted=false',
      [req.params.ticketId]);
    if (Number(cnt.count) >= 5) return res.status(400).json({ error:'Max 5 attachments per ticket' });

    // Get customer retention policy
    const { rows:[ticket] } = await pool.query(
      'SELECT customer_org_id FROM tickets WHERE id=$1', [req.params.ticketId]);
    let retentionDays = 90;
    if (ticket?.customer_org_id) {
      const { rows:[cust] } = await pool.query(
        'SELECT attachment_retention_days FROM customers WHERE id=$1', [ticket.customer_org_id]);
      if (cust) retentionDays = cust.attachment_retention_days || 90;
    }

    const storagePath = `${req.params.ticketId}/${Date.now()}-${fileName}`;
    const buffer = Buffer.from(fileData, 'base64');

    if (SUPABASE_URL && SUPABASE_KEY) {
      await supabaseUpload(storagePath, buffer, fileType);
    }

    const deleteAfter = new Date();
    deleteAfter.setDate(deleteAfter.getDate() + retentionDays);

    const { rows:[attachment] } = await pool.query(
      `INSERT INTO ticket_attachments (ticket_id,uploader_id,file_name,file_size,file_type,storage_path,delete_after)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.ticketId, req.user.id, fileName, fileSize, fileType, storagePath, deleteAfter]);

    await pool.query(
      `INSERT INTO ticket_history (ticket_id,actor_id,field_changed,new_value)
       VALUES ($1,$2,'attachment_added',$3)`, [req.params.ticketId, req.user.id, fileName]);

    res.status(201).json({ success:true, data:attachment });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get download URL
router.get('/:attachmentId/url', authenticate, async (req, res) => {
  try {
    const { rows:[att] } = await pool.query(
      'SELECT * FROM ticket_attachments WHERE id=$1 AND deleted=false', [req.params.attachmentId]);
    if (!att) return res.status(404).json({ error:'Not found' });

    let url = null;
    if (SUPABASE_URL && SUPABASE_KEY) {
      url = await supabaseSignedUrl(att.storage_path);
    } else {
      url = '#'; // fallback for dev
    }
    res.json({ success:true, url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete attachment
router.delete('/:attachmentId', authenticate, async (req, res) => {
  try {
    const { rows:[att] } = await pool.query(
      'SELECT * FROM ticket_attachments WHERE id=$1', [req.params.attachmentId]);
    if (!att) return res.status(404).json({ error:'Not found' });

    if (SUPABASE_URL && SUPABASE_KEY) {
      await supabaseDelete(att.storage_path);
    }
    await pool.query(
      'UPDATE ticket_attachments SET deleted=true, deleted_at=NOW() WHERE id=$1', [req.params.attachmentId]);
    await pool.query(
      `INSERT INTO ticket_history (ticket_id,actor_id,field_changed,old_value)
       VALUES ($1,$2,'attachment_deleted',$3)`, [att.ticket_id, req.user.id, att.file_name]);
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Auto-delete expired attachments (called by cron or scheduled)
router.post('/cleanup/expired', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM ticket_attachments WHERE deleted=false AND delete_after < NOW()`);
    let deleted = 0;
    for (const att of rows) {
      try {
        if (SUPABASE_URL && SUPABASE_KEY) await supabaseDelete(att.storage_path);
        await pool.query(
          'UPDATE ticket_attachments SET deleted=true, deleted_at=NOW() WHERE id=$1', [att.id]);
        await pool.query(
          `INSERT INTO ticket_history (ticket_id,actor_id,field_changed,old_value)
           VALUES ($1,NULL,'auto_deleted_attachment',$2)`, [att.ticket_id, att.file_name]);
        deleted++;
      } catch {}
    }
    res.json({ success:true, deleted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
