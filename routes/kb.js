const router = require('express').Router();
const pool   = require('../config/db');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, async (req, res) => {
  try {
    const { q,category } = req.query;
    let sql=`SELECT k.*,u.name AS author_name FROM kb_articles k LEFT JOIN users u ON u.id=k.author_id WHERE k.published=true`;
    const params=[];
    if (q) { params.push(`%${q}%`); sql+=` AND (k.title ILIKE $${params.length} OR k.content ILIKE $${params.length})`; }
    if (category) { params.push(category); sql+=` AND k.category=$${params.length}`; }
    sql+=' ORDER BY k.views DESC,k.created_at DESC';
    const { rows } = await pool.query(sql,params);
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.get('/:id', authenticate, async (req, res) => {
  try {
    await pool.query('UPDATE kb_articles SET views=views+1 WHERE id=$1',[req.params.id]);
    const { rows:[a] } = await pool.query(`SELECT k.*,u.name AS author_name FROM kb_articles k LEFT JOIN users u ON u.id=k.author_id WHERE k.id=$1`,[req.params.id]);
    if (!a) return res.status(404).json({error:'Not found'});
    res.json({ success:true, data:a });
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.post('/', authenticate, async (req, res) => {
  try {
    const { title,content,category,published=false } = req.body;
    if (!title||!content) return res.status(400).json({error:'Title and content required'});
    const { rows:[a] } = await pool.query(
      `INSERT INTO kb_articles (title,content,category,author_id,published) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [title,content,category,req.user.id,published]);
    res.status(201).json({ success:true, data:a });
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { title,content,category,published } = req.body;
    const { rows:[a] } = await pool.query(
      `UPDATE kb_articles SET title=COALESCE($1,title),content=COALESCE($2,content),category=COALESCE($3,category),published=COALESCE($4,published),updated_at=NOW() WHERE id=$5 RETURNING *`,
      [title,content,category,published,req.params.id]);
    res.json({ success:true, data:a });
  } catch(e) { res.status(500).json({error:e.message}); }
});
router.delete('/:id', authenticate, async (req, res) => {
  await pool.query('DELETE FROM kb_articles WHERE id=$1',[req.params.id]);
  res.json({ success:true });
});
module.exports = router;
