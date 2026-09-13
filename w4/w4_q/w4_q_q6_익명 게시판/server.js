const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

// ── .env 파일 읽어서 process.env에 넣기 ─────
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile();

const app = express();
const PORT = process.env.PORT || 4010;

const CATEGORIES = ['고민', '칭찬', '응원'];
const BEST_LIKES_THRESHOLD = 10;

// Supabase 연결 (SSL 필요)
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── 테이블 준비 (없으면 생성, 기존 posts에는 컬럼 보강) ─────
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      likes INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS author_client_id TEXT NOT NULL DEFAULT ''`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS replies (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      likes INTEGER NOT NULL DEFAULT 0,
      author_client_id TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_likes (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      PRIMARY KEY (post_id, client_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reply_likes (
      reply_id INTEGER NOT NULL REFERENCES replies(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      PRIMARY KEY (reply_id, client_id)
    )
  `);

  dbInitialized = true;
}

app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('DB init failed:', err);
    res.status(500).json({ success: false, message: 'Database initialization failed' });
  }
});

function requireClientId(req, res) {
  const clientId = (req.body && req.body.clientId) || req.query.clientId;
  if (!clientId || !String(clientId).trim()) {
    res.status(400).json({ success: false, message: 'clientId is required' });
    return null;
  }
  return String(clientId).trim();
}

// ── 게시글 목록 (카테고리 필터 + 정렬 + 답글 수 + 내 공감 여부) ─────
app.get('/api/posts', async (req, res) => {
  try {
    const { category, sort, clientId } = req.query;
    const orderBy = sort === 'likes' ? 'p.likes DESC, p.created_at DESC' : 'p.created_at DESC';

    const conditions = [];
    const params = [];

    if (category && CATEGORIES.includes(String(category))) {
      params.push(category);
      conditions.push(`p.category = $${params.length}`);
    }

    params.push(clientId || '');
    const clientParamIdx = params.length;

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT p.*,
              COUNT(DISTINCT r.id) AS reply_count,
              BOOL_OR(pl.client_id IS NOT NULL) AS liked,
              (p.author_client_id = $${clientParamIdx}) AS mine
       FROM posts p
       LEFT JOIN replies r ON r.post_id = p.id
       LEFT JOIN post_likes pl ON pl.post_id = p.id AND pl.client_id = $${clientParamIdx}
       ${where}
       GROUP BY p.id
       ORDER BY ${orderBy}`,
      params
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── 베스트 게시글 (공감 10개 이상, 공감순 -> 답글수 순) ─────
app.get('/api/posts/best', async (req, res) => {
  try {
    const { clientId } = req.query;
    const result = await pool.query(
      `SELECT p.*,
              COUNT(DISTINCT r.id) AS reply_count,
              BOOL_OR(pl.client_id IS NOT NULL) AS liked,
              (p.author_client_id = $1) AS mine
       FROM posts p
       LEFT JOIN replies r ON r.post_id = p.id
       LEFT JOIN post_likes pl ON pl.post_id = p.id AND pl.client_id = $1
       GROUP BY p.id
       HAVING p.likes >= $2
       ORDER BY p.likes DESC, COUNT(DISTINCT r.id) DESC, p.created_at DESC`,
      [clientId || '', BEST_LIKES_THRESHOLD]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── 게시글 작성 ─────
app.post('/api/posts', async (req, res) => {
  try {
    const { category, content } = req.body || {};
    const clientId = requireClientId(req, res);
    if (!clientId) return;

    if (!CATEGORIES.includes(String(category))) {
      return res.status(400).json({ success: false, message: 'invalid category' });
    }
    if (!content || !String(content).trim()) {
      return res.status(400).json({ success: false, message: 'content is required' });
    }

    const result = await pool.query(
      `INSERT INTO posts (category, content, author_client_id) VALUES ($1, $2, $3) RETURNING *`,
      [category, String(content).trim(), clientId]
    );
    res.status(201).json({ success: true, data: { ...result.rows[0], reply_count: 0, liked: false, mine: true } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── 게시글 수정 (작성자 본인만) ─────
app.put('/api/posts/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'invalid id' });
    }
    const { category, content } = req.body || {};
    const clientId = requireClientId(req, res);
    if (!clientId) return;

    if (!CATEGORIES.includes(String(category))) {
      return res.status(400).json({ success: false, message: 'invalid category' });
    }
    if (!content || !String(content).trim()) {
      return res.status(400).json({ success: false, message: 'content is required' });
    }

    const result = await pool.query(
      `UPDATE posts SET category = $1, content = $2
       WHERE id = $3 AND author_client_id = $4 RETURNING *`,
      [category, String(content).trim(), id, clientId]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({ success: false, message: '본인 글만 수정할 수 있습니다' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── 게시글 삭제 (작성자 본인만, 답글/공감 기록은 CASCADE) ─────
app.delete('/api/posts/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'invalid id' });
    }
    const clientId = requireClientId(req, res);
    if (!clientId) return;

    const result = await pool.query(
      `DELETE FROM posts WHERE id = $1 AND author_client_id = $2 RETURNING *`,
      [id, clientId]
    );
    if (result.rows.length === 0) {
      return res.status(403).json({ success: false, message: '본인 글만 삭제할 수 있습니다' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── 게시글 공감 토글 (같은 clientId가 다시 누르면 취소) ─────
app.put('/api/posts/:id/like', async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'invalid id' });
    }
    const clientId = requireClientId(req, res);
    if (!clientId) return;

    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT 1 FROM post_likes WHERE post_id = $1 AND client_id = $2`,
      [id, clientId]
    );

    let liked;
    if (existing.rows.length > 0) {
      await client.query(`DELETE FROM post_likes WHERE post_id = $1 AND client_id = $2`, [id, clientId]);
      await client.query(`UPDATE posts SET likes = GREATEST(likes - 1, 0) WHERE id = $1`, [id]);
      liked = false;
    } else {
      await client.query(`INSERT INTO post_likes (post_id, client_id) VALUES ($1, $2)`, [id, clientId]);
      await client.query(`UPDATE posts SET likes = likes + 1 WHERE id = $1`, [id]);
      liked = true;
    }

    const result = await client.query(`SELECT * FROM posts WHERE id = $1`, [id]);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    await client.query('COMMIT');
    res.json({ success: true, data: { ...result.rows[0], liked } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── 답글 목록 ─────
app.get('/api/posts/:id/replies', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'invalid id' });
    }
    const { clientId } = req.query;

    const result = await pool.query(
      `SELECT r.*,
              BOOL_OR(rl.client_id IS NOT NULL) AS liked,
              (r.author_client_id = $2) AS mine
       FROM replies r
       LEFT JOIN reply_likes rl ON rl.reply_id = r.id AND rl.client_id = $2
       WHERE r.post_id = $1
       GROUP BY r.id
       ORDER BY r.created_at ASC`,
      [id, clientId || '']
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── 답글 작성 ─────
app.post('/api/posts/:id/replies', async (req, res) => {
  try {
    const postId = Number(req.params.id);
    if (!Number.isInteger(postId)) {
      return res.status(400).json({ success: false, message: 'invalid id' });
    }
    const { content } = req.body || {};
    const clientId = requireClientId(req, res);
    if (!clientId) return;

    if (!content || !String(content).trim()) {
      return res.status(400).json({ success: false, message: 'content is required' });
    }

    const result = await pool.query(
      `INSERT INTO replies (post_id, content, author_client_id) VALUES ($1, $2, $3) RETURNING *`,
      [postId, String(content).trim(), clientId]
    );
    res.status(201).json({ success: true, data: { ...result.rows[0], liked: false, mine: true } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── 답글 수정 (작성자 본인만) ─────
app.put('/api/replies/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'invalid id' });
    }
    const { content } = req.body || {};
    const clientId = requireClientId(req, res);
    if (!clientId) return;

    if (!content || !String(content).trim()) {
      return res.status(400).json({ success: false, message: 'content is required' });
    }

    const result = await pool.query(
      `UPDATE replies SET content = $1 WHERE id = $2 AND author_client_id = $3 RETURNING *`,
      [String(content).trim(), id, clientId]
    );
    if (result.rows.length === 0) {
      return res.status(403).json({ success: false, message: '본인 답글만 수정할 수 있습니다' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── 답글 삭제 (작성자 본인만) ─────
app.delete('/api/replies/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'invalid id' });
    }
    const clientId = requireClientId(req, res);
    if (!clientId) return;

    const result = await pool.query(
      `DELETE FROM replies WHERE id = $1 AND author_client_id = $2 RETURNING *`,
      [id, clientId]
    );
    if (result.rows.length === 0) {
      return res.status(403).json({ success: false, message: '본인 답글만 삭제할 수 있습니다' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── 답글 공감 토글 ─────
app.put('/api/replies/:id/like', async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'invalid id' });
    }
    const clientId = requireClientId(req, res);
    if (!clientId) return;

    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT 1 FROM reply_likes WHERE reply_id = $1 AND client_id = $2`,
      [id, clientId]
    );

    let liked;
    if (existing.rows.length > 0) {
      await client.query(`DELETE FROM reply_likes WHERE reply_id = $1 AND client_id = $2`, [id, clientId]);
      await client.query(`UPDATE replies SET likes = GREATEST(likes - 1, 0) WHERE id = $1`, [id]);
      liked = false;
    } else {
      await client.query(`INSERT INTO reply_likes (reply_id, client_id) VALUES ($1, $2)`, [id, clientId]);
      await client.query(`UPDATE replies SET likes = likes + 1 WHERE id = $1`, [id]);
      liked = true;
    }

    const result = await client.query(`SELECT * FROM replies WHERE id = $1`, [id]);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Reply not found' });
    }

    await client.query('COMMIT');
    res.json({ success: true, data: { ...result.rows[0], liked } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ── SPA fallback (Express 5 문법) ───────────────────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ───────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
