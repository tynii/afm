const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
const PORT = process.env.PORT || 4020;

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CATEGORIES = ['전자기기', '패션/잡화', '가구/생활', '취미/굿즈', '기타'];
const TEST_ACCOUNTS = [
  { username: 'test1', password: 'test1234' },
  { username: 'test2', password: 'test1234' },
];

// Supabase 연결 (SSL 필요)
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

// 토큰 서명 키: AUTH_SECRET이 없으면 DATABASE_URL에서 파생
const AUTH_SECRET = process.env.AUTH_SECRET
  || crypto.createHash('sha256').update('community-auth:' + (process.env.DATABASE_URL || 'dev')).digest('hex');

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── 비밀번호 해시 (scrypt) / 토큰 (HMAC 서명) ─────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function signToken(user) {
  const payload = Buffer.from(
    JSON.stringify({ id: user.id, username: user.username, exp: Date.now() + TOKEN_TTL_MS })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const user = verifyToken(header.startsWith('Bearer ') ? header.slice(7) : '');
  if (!user) {
    return res.status(401).json({ success: false, message: '로그인이 필요합니다' });
  }
  req.user = user;
  next();
}

// ── 테이블 준비 (원본 익명 게시판 테이블과 겹치지 않도록 community_ 접두사 사용) ─────
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT '기타'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_comments (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_post_likes (
      post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
      PRIMARY KEY (post_id, user_id)
    )
  `);
  for (const acc of TEST_ACCOUNTS) {
    await pool.query(
      `INSERT INTO community_users (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING`,
      [acc.username, hashPassword(acc.password)]
    );
  }
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

// ── 회원가입 ─────
app.post('/api/auth/signup', async (req, res) => {
  try {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    if (!/^[A-Za-z0-9가-힣_]{2,20}$/.test(username)) {
      return res.status(400).json({ success: false, message: '아이디는 2~20자의 한글/영문/숫자/_ 만 사용할 수 있습니다' });
    }
    if (password.length < 4 || password.length > 100) {
      return res.status(400).json({ success: false, message: '비밀번호는 4자 이상이어야 합니다' });
    }
    const result = await pool.query(
      `INSERT INTO community_users (username, password_hash) VALUES ($1, $2)
       ON CONFLICT (username) DO NOTHING RETURNING id, username`,
      [username, hashPassword(password)]
    );
    if (result.rows.length === 0) {
      return res.status(409).json({ success: false, message: '이미 사용 중인 아이디입니다' });
    }
    const user = result.rows[0];
    res.status(201).json({ success: true, data: { token: signToken(user), user } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── 로그인 ─────
app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const result = await pool.query(
      `SELECT id, username, password_hash FROM community_users WHERE username = $1`,
      [username]
    );
    const row = result.rows[0];
    if (!row || !verifyPassword(password, row.password_hash)) {
      return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다' });
    }
    const user = { id: row.id, username: row.username };
    res.json({ success: true, data: { token: signToken(user), user } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── 내 정보 (저장된 토큰이 아직 유효한지 확인) ─────
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, data: { id: req.user.id, username: req.user.username } });
});

function validatePost(body) {
  const title = String((body && body.title) || '').trim();
  const content = String((body && body.content) || '').trim();
  if (!title) return { error: '제목을 입력해주세요' };
  if (!content) return { error: '내용을 입력해주세요' };
  if (title.length > 100) return { error: '제목은 100자 이내로 입력해주세요' };
  const category = String((body && body.category) || '');
  if (!CATEGORIES.includes(category)) return { error: '카테고리를 선택해주세요' };
  return { title, content, category };
}

// 목록/작성/수정 응답에 공통으로 쓰는 게시글 SELECT (공감 수, 내 공감 여부, 댓글 수 포함)
const POST_SELECT = `
  SELECT p.id, p.title, p.content, p.category, p.created_at,
         u.username AS author, (p.user_id = $1) AS mine,
         (SELECT COUNT(*)::int FROM community_post_likes l WHERE l.post_id = p.id) AS like_count,
         EXISTS (SELECT 1 FROM community_post_likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked,
         (SELECT COUNT(*)::int FROM community_comments c WHERE c.post_id = p.id) AS comment_count
  FROM community_posts p
  JOIN community_users u ON u.id = p.user_id`;

async function fetchPost(id, userId) {
  const result = await pool.query(`${POST_SELECT} WHERE p.id = $2`, [userId, id]);
  return result.rows[0];
}

app.get('/api/categories', requireAuth, (_req, res) => {
  res.json({ success: true, data: CATEGORIES });
});

// ── 게시글 목록 (로그인한 누구나, 최신순) ─────
app.get('/api/posts', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`${POST_SELECT} ORDER BY p.created_at DESC, p.id DESC`, [req.user.id]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── 게시글 작성 ─────
app.post('/api/posts', requireAuth, async (req, res) => {
  try {
    const v = validatePost(req.body);
    if (v.error) return res.status(400).json({ success: false, message: v.error });
    const result = await pool.query(
      `INSERT INTO community_posts (user_id, title, content, category) VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.user.id, v.title, v.content, v.category]
    );
    res.status(201).json({ success: true, data: await fetchPost(result.rows[0].id, req.user.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── 게시글 수정 (작성자 본인만) ─────
app.put('/api/posts/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'invalid id' });
    const v = validatePost(req.body);
    if (v.error) return res.status(400).json({ success: false, message: v.error });

    const result = await pool.query(
      `UPDATE community_posts SET title = $1, content = $2, category = $3 WHERE id = $4 AND user_id = $5 RETURNING id`,
      [v.title, v.content, v.category, id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(403).json({ success: false, message: '본인 글만 수정할 수 있습니다' });
    }
    res.json({ success: true, data: await fetchPost(id, req.user.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── 게시글 삭제 (작성자 본인만) ─────
app.delete('/api/posts/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'invalid id' });
    const result = await pool.query(
      `DELETE FROM community_posts WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, req.user.id]
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

// ── 공감 토글 (한 사람이 한 번, 다시 누르면 취소) ─────
app.put('/api/posts/:id/like', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'invalid id' });
    if (!(await fetchPost(id, req.user.id))) {
      return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다' });
    }
    const removed = await pool.query(
      `DELETE FROM community_post_likes WHERE post_id = $1 AND user_id = $2 RETURNING post_id`,
      [id, req.user.id]
    );
    if (removed.rows.length === 0) {
      await pool.query(
        `INSERT INTO community_post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, req.user.id]
      );
    }
    res.json({ success: true, data: await fetchPost(id, req.user.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── 댓글 목록 / 작성 / 삭제(작성자 본인만) ─────
app.get('/api/posts/:id/comments', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'invalid id' });
    const result = await pool.query(
      `SELECT c.id, c.content, c.created_at, u.username AS author, (c.user_id = $2) AS mine
       FROM community_comments c
       JOIN community_users u ON u.id = c.user_id
       WHERE c.post_id = $1
       ORDER BY c.created_at ASC, c.id ASC`,
      [id, req.user.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.post('/api/posts/:id/comments', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'invalid id' });
    const content = String((req.body && req.body.content) || '').trim();
    if (!content) return res.status(400).json({ success: false, message: '댓글 내용을 입력해주세요' });
    if (content.length > 500) return res.status(400).json({ success: false, message: '댓글은 500자 이내로 입력해주세요' });
    if (!(await fetchPost(id, req.user.id))) {
      return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다' });
    }
    const result = await pool.query(
      `INSERT INTO community_comments (post_id, user_id, content) VALUES ($1, $2, $3) RETURNING id, content, created_at`,
      [id, req.user.id, content]
    );
    res.status(201).json({ success: true, data: { ...result.rows[0], author: req.user.username, mine: true } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.delete('/api/comments/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'invalid id' });
    const result = await pool.query(
      `DELETE FROM community_comments WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(403).json({ success: false, message: '본인 댓글만 삭제할 수 있습니다' });
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

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
module.exports = app;
