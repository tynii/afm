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
const PORT = process.env.PORT || 4003;

// Supabase 연결 (SSL 필요)
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── memos 테이블 준비 (없으면 생성) ─────────
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memos (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

// ── API routes ───────────────────────────────

// 조회: 전체 메모 목록 (검색어가 있으면 제목/내용에서 검색)
app.get('/api/memos', async (req, res) => {
  try {
    const { search } = req.query;
    if (search && String(search).trim()) {
      const keyword = `%${String(search).trim()}%`;
      const result = await pool.query(
        `SELECT * FROM memos WHERE title ILIKE $1 OR content ILIKE $1 ORDER BY created_at DESC`,
        [keyword]
      );
      return res.json({ success: true, data: result.rows });
    }
    const result = await pool.query('SELECT * FROM memos ORDER BY created_at DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 생성(저장): 새 메모 추가
app.post('/api/memos', async (req, res) => {
  try {
    const { title, content } = req.body || {};
    if (!title || !String(title).trim()) {
      return res.status(400).json({ success: false, message: 'title is required' });
    }

    const result = await pool.query(
      `INSERT INTO memos (title, content) VALUES ($1, $2) RETURNING *`,
      [String(title).trim(), content ? String(content) : '']
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 수정
app.put('/api/memos/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'invalid id' });
    }

    const { title, content } = req.body || {};
    if (!title || !String(title).trim()) {
      return res.status(400).json({ success: false, message: 'title is required' });
    }

    const result = await pool.query(
      `UPDATE memos SET title = $1, content = $2 WHERE id = $3 RETURNING *`,
      [String(title).trim(), content ? String(content) : '', id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Memo not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 삭제
app.delete('/api/memos/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'invalid id' });
    }
    const result = await pool.query(`DELETE FROM memos WHERE id = $1 RETURNING *`, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Memo not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
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
