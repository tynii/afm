const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

// ── .env 파일 읽어서 process.env에 넣기 ─────
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    if (!(key in process.env)) process.env[key] = trimmed.slice(idx + 1).trim();
  }
}
loadEnvFile();

const app = express();
const PORT = process.env.PORT || 4006;

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const DEFAULT_CATEGORIES = {
  expense: ['식비', '교통', '주거', '구독료', '경조사', '쇼핑', '의료', '기타'],
  income: ['월급', '용돈', '부수입', '기타'],
};

// ── DB lazy init ─────────────────────────────
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
      entry_date DATE NOT NULL,
      amount BIGINT NOT NULL CHECK (amount > 0),
      category TEXT NOT NULL,
      memo TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ledger_categories (
      type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
      name TEXT NOT NULL,
      PRIMARY KEY (type, name)
    )
  `);
  const { rows } = await pool.query('SELECT 1 FROM ledger_categories LIMIT 1');
  if (!rows.length) {
    for (const [type, names] of Object.entries(DEFAULT_CATEGORIES)) {
      for (const name of names) {
        await pool.query('INSERT INTO ledger_categories (type, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [type, name]);
      }
    }
  }
  dbInitialized = true;
}

app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Database initialization failed' });
  }
});

const ENTRY_COLUMNS = `id, type, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, amount::float8 AS amount, category, memo`;

// ── API: GET ─────────────────────────────────
app.get('/api/entries', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${ENTRY_COLUMNS} FROM ledger_entries ORDER BY entry_date DESC, id DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

app.get('/api/summary', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT type, category, SUM(amount)::float8 AS total, COUNT(*)::int AS count
       FROM ledger_entries GROUP BY type, category ORDER BY total DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

app.get('/api/categories', async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT type, name FROM ledger_categories ORDER BY type DESC, name');
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── API: POST ────────────────────────────────
// 등록/수정 공용 검증: 오류면 { message }, 통과하면 { values }
function parseEntry(body) {
  const { type, entry_date, amount, category, memo } = body || {};
  const amt = Number(amount);
  if (!['income', 'expense'].includes(type)) return { message: '구분(수입/지출)이 올바르지 않아요' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry_date || '') || Number.isNaN(Date.parse(entry_date))) {
    return { message: '날짜가 올바르지 않아요' };
  }
  if (!Number.isInteger(amt) || amt <= 0) return { message: '금액은 1 이상의 정수여야 해요' };
  if (typeof category !== 'string' || !category.trim()) return { message: '카테고리를 입력해 주세요' };
  return { values: [type, entry_date, amt, category.trim().slice(0, 30), String(memo || '').slice(0, 200)] };
}

app.post('/api/entries', async (req, res, next) => {
  try {
    const { message, values } = parseEntry(req.body);
    if (message) return res.status(400).json({ success: false, message });
    const { rows } = await pool.query(
      `INSERT INTO ledger_entries (type, entry_date, amount, category, memo)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${ENTRY_COLUMNS}`,
      values
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
});

// ── API: PUT ─────────────────────────────────
app.put('/api/entries/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'invalid id' });
    const { message, values } = parseEntry(req.body);
    if (message) return res.status(400).json({ success: false, message });
    const { rows } = await pool.query(
      `UPDATE ledger_entries SET type = $1, entry_date = $2, amount = $3, category = $4, memo = $5
       WHERE id = $6 RETURNING ${ENTRY_COLUMNS}`,
      [...values, id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Entry not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
});

app.post('/api/categories', async (req, res, next) => {
  try {
    const { type, name } = req.body || {};
    const trimmed = typeof name === 'string' ? name.trim().slice(0, 20) : '';
    if (!['income', 'expense'].includes(type) || !trimmed) {
      return res.status(400).json({ success: false, message: '구분과 카테고리 이름을 확인해 주세요' });
    }
    const { rowCount } = await pool.query(
      'INSERT INTO ledger_categories (type, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [type, trimmed]);
    if (!rowCount) return res.status(409).json({ success: false, message: '이미 있는 카테고리예요' });
    res.status(201).json({ success: true, data: { type, name: trimmed } });
  } catch (err) { next(err); }
});

// ── API: DELETE ──────────────────────────────
app.delete('/api/entries/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: 'invalid id' });
    }
    const { rowCount } = await pool.query('DELETE FROM ledger_entries WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Entry not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

app.delete('/api/categories/:type/:name', async (req, res, next) => {
  try {
    const { type, name } = req.params;
    const used = await pool.query('SELECT 1 FROM ledger_entries WHERE type = $1 AND category = $2 LIMIT 1', [type, name]);
    if (used.rows.length) {
      return res.status(409).json({ success: false, message: '내역에서 사용 중인 카테고리는 삭제할 수 없어요' });
    }
    await pool.query('DELETE FROM ledger_categories WHERE type = $1 AND name = $2', [type, name]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── SPA fallback (Express 5) ─────────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
module.exports = app;
