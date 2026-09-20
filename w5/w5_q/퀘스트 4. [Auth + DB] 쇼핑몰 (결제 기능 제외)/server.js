const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
const PORT = process.env.PORT || 4030;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_QTY = 99;
const TEST_ACCOUNTS = [{ username: 'test1', password: 'test1234' }];

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});
const AUTH_SECRET = process.env.AUTH_SECRET
  || crypto.createHash('sha256').update('tea-shop-auth:' + (process.env.DATABASE_URL || 'dev')).digest('hex');

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── 비밀번호 해시 / 토큰 ─────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}
function signToken(user) {
  const payload = Buffer.from(JSON.stringify({ id: user.id, username: user.username, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const user = verifyToken(header.startsWith('Bearer ') ? header.slice(7) : '');
  if (!user) return res.status(401).json({ success: false, message: '로그인이 필요합니다' });
  req.user = user;
  next();
}

// ── 시드 상품 (category: tea=차, teaware=다구 / 이미지: Unsplash 무료 이미지) ─────
const SEED_PRODUCTS = [
  {
    "slug": "sejak-green",
    "category": "tea",
    "name": "우전 녹차 (세작)",
    "price": 18000,
    "description": "이른 봄 첫 잎으로 만든 부드럽고 청량한 녹차. 50g",
    "image_url": "https://images.unsplash.com/photo-1763617702099-d956f3fd8324?w=600&h=450&fit=crop&q=75"
  },
  {
    "slug": "jeju-matcha",
    "category": "tea",
    "name": "제주 말차 가루",
    "price": 24000,
    "description": "곱게 갈아 진한 초록빛과 감칠맛이 살아있는 말차. 40g",
    "image_url": "https://images.unsplash.com/photo-1565117661210-fd54898de423?w=600&h=450&fit=crop&q=75"
  },
  {
    "slug": "hwangcha",
    "category": "tea",
    "name": "구증구포 황차",
    "price": 21000,
    "description": "은은한 단맛과 구수한 향이 어우러진 발효차. 50g",
    "image_url": "https://images.unsplash.com/photo-1604697976842-d36fa5a1b2ed?w=600&h=450&fit=crop&q=75"
  },
  {
    "slug": "black-tea",
    "category": "tea",
    "name": "하동 수제 홍차",
    "price": 16500,
    "description": "달콤한 꿀 향이 나는 국산 홍차. 50g",
    "image_url": "https://images.unsplash.com/photo-1759523710626-199a2da96085?w=600&h=450&fit=crop&q=75"
  },
  {
    "slug": "pu-erh",
    "category": "tea",
    "name": "숙성 보이차",
    "price": 32000,
    "description": "깊고 묵직한 맛의 5년 숙성 보이차. 100g",
    "image_url": "https://images.unsplash.com/photo-1606163017137-888c0177b3dd?w=600&h=450&fit=crop&q=75"
  },
  {
    "slug": "teapot-ceramic",
    "category": "teaware",
    "name": "백자 다관 (300ml)",
    "price": 45000,
    "description": "손에 착 감기는 백자 다관. 잎차 우리기에 알맞은 크기",
    "image_url": "https://images.unsplash.com/photo-1683558654439-8b9986cbf1dd?w=600&h=450&fit=crop&q=75"
  },
  {
    "slug": "teacup-set",
    "category": "teaware",
    "name": "청화 찻잔 세트 (2인)",
    "price": 28000,
    "description": "깔끔한 청화 무늬 찻잔 2개와 받침 세트",
    "image_url": "https://images.unsplash.com/photo-1695313129665-3a6028d8b9c8?w=600&h=450&fit=crop&q=75"
  },
  {
    "slug": "matcha-whisk",
    "category": "teaware",
    "name": "대나무 차선",
    "price": 12000,
    "description": "말차를 곱게 풀어주는 수제 대나무 차선",
    "image_url": "https://images.unsplash.com/photo-1589698272390-0501a07619bb?w=600&h=450&fit=crop&q=75"
  },
  {
    "slug": "tea-strainer",
    "category": "teaware",
    "name": "스테인리스 찻망",
    "price": 7500,
    "description": "미세 망으로 찻잎을 깔끔하게 걸러주는 찻망",
    "image_url": "https://images.unsplash.com/photo-1521136492500-e18f107709f7?w=600&h=450&fit=crop&q=75"
  },
  {
    "slug": "tea-tray",
    "category": "teaware",
    "name": "원목 차판",
    "price": 39000,
    "description": "물이 빠지는 차판. 다관과 찻잔을 함께 놓기 좋은 크기",
    "image_url": "https://images.unsplash.com/photo-1515365389034-da2da8678c14?w=600&h=450&fit=crop&q=75"
  }
];

// ── 테이블 준비 (tea_ 접두사) ─────
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS tea_users (
    id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS tea_products (
    id SERIAL PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    price INTEGER NOT NULL, description TEXT NOT NULL, image_url TEXT NOT NULL)`);
  await pool.query(`ALTER TABLE tea_products ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'tea'`);
  await pool.query(`CREATE TABLE IF NOT EXISTS tea_cart_items (
    user_id INTEGER NOT NULL REFERENCES tea_users(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES tea_products(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL CHECK (quantity >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, product_id))`);
  for (const p of SEED_PRODUCTS) {
    await pool.query(
      `INSERT INTO tea_products (slug, name, price, description, image_url, category) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (slug) DO UPDATE SET name=$2, price=$3, description=$4, image_url=$5, category=$6`,
      [p.slug, p.name, p.price, p.description, p.image_url, p.category]);
  }
  for (const acc of TEST_ACCOUNTS) {
    await pool.query(`INSERT INTO tea_users (username, password_hash) VALUES ($1,$2) ON CONFLICT (username) DO NOTHING`,
      [acc.username, hashPassword(acc.password)]);
  }
  dbInitialized = true;
}
app.use('/api', async (_req, res, next) => {
  try { await initDB(); next(); }
  catch (err) { console.error('DB init failed:', err); res.status(500).json({ success: false, message: 'Database initialization failed' }); }
});

const fail500 = (res, err) => { console.error(err); res.status(500).json({ success: false, message: 'Internal server error' }); };

// ── 인증 ─────
app.post('/api/auth/signup', async (req, res) => {
  try {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    if (!/^[A-Za-z0-9가-힣_]{2,20}$/.test(username))
      return res.status(400).json({ success: false, message: '아이디는 2~20자의 한글/영문/숫자/_ 만 사용할 수 있습니다' });
    if (password.length < 4 || password.length > 100)
      return res.status(400).json({ success: false, message: '비밀번호는 4자 이상이어야 합니다' });
    const r = await pool.query(
      `INSERT INTO tea_users (username, password_hash) VALUES ($1,$2) ON CONFLICT (username) DO NOTHING RETURNING id, username`,
      [username, hashPassword(password)]);
    if (!r.rows.length) return res.status(409).json({ success: false, message: '이미 사용 중인 아이디입니다' });
    res.status(201).json({ success: true, data: { token: signToken(r.rows[0]), user: r.rows[0] } });
  } catch (err) { fail500(res, err); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const r = await pool.query(`SELECT id, username, password_hash FROM tea_users WHERE username = $1`, [username]);
    const row = r.rows[0];
    if (!row || !verifyPassword(password, row.password_hash))
      return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다' });
    const user = { id: row.id, username: row.username };
    res.json({ success: true, data: { token: signToken(user), user } });
  } catch (err) { fail500(res, err); }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, data: { id: req.user.id, username: req.user.username } });
});

// ── 상품 목록 (로그인 불필요) ─────
app.get('/api/products', async (_req, res) => {
  try {
    const r = await pool.query(`SELECT id, name, price, description, image_url, category FROM tea_products ORDER BY id`);
    res.json({ success: true, data: r.rows });
  } catch (err) { fail500(res, err); }
});

// ── 장바구니 (로그인 필수) ─────
async function fetchCart(userId) {
  const r = await pool.query(
    `SELECT p.id AS product_id, p.name, p.price, p.description, p.image_url, c.quantity
     FROM tea_cart_items c JOIN tea_products p ON p.id = c.product_id
     WHERE c.user_id = $1 ORDER BY c.created_at, p.id`, [userId]);
  return r.rows;
}
const parseId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

app.get('/api/cart', requireAuth, async (req, res) => {
  try { res.json({ success: true, data: await fetchCart(req.user.id) }); } catch (err) { fail500(res, err); }
});

// 담기: 이미 있으면 수량 +1
app.post('/api/cart', requireAuth, async (req, res) => {
  try {
    const productId = parseId(req.body && req.body.productId);
    if (!productId) return res.status(400).json({ success: false, message: 'invalid productId' });
    const exists = await pool.query(`SELECT 1 FROM tea_products WHERE id = $1`, [productId]);
    if (!exists.rows.length) return res.status(404).json({ success: false, message: '상품을 찾을 수 없습니다' });
    await pool.query(
      `INSERT INTO tea_cart_items (user_id, product_id, quantity) VALUES ($1,$2,1)
       ON CONFLICT (user_id, product_id) DO UPDATE SET quantity = LEAST(tea_cart_items.quantity + 1, ${MAX_QTY})`,
      [req.user.id, productId]);
    res.status(201).json({ success: true, data: await fetchCart(req.user.id) });
  } catch (err) { fail500(res, err); }
});

// 수량 변경 (+/-)
app.put('/api/cart/:productId', requireAuth, async (req, res) => {
  try {
    const productId = parseId(req.params.productId);
    const quantity = Number(req.body && req.body.quantity);
    if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY)
      return res.status(400).json({ success: false, message: `수량은 1~${MAX_QTY} 사이여야 합니다` });
    const r = await pool.query(
      `UPDATE tea_cart_items SET quantity = $1 WHERE user_id = $2 AND product_id = $3 RETURNING product_id`,
      [quantity, req.user.id, productId]);
    if (!r.rows.length) return res.status(404).json({ success: false, message: '장바구니에 없는 상품입니다' });
    res.json({ success: true, data: await fetchCart(req.user.id) });
  } catch (err) { fail500(res, err); }
});

// 삭제
app.delete('/api/cart/:productId', requireAuth, async (req, res) => {
  try {
    const productId = parseId(req.params.productId);
    if (!productId) return res.status(400).json({ success: false, message: 'invalid id' });
    await pool.query(`DELETE FROM tea_cart_items WHERE user_id = $1 AND product_id = $2`, [req.user.id, productId]);
    res.json({ success: true, data: await fetchCart(req.user.id) });
  } catch (err) { fail500(res, err); }
});

// ── SPA fallback / 에러 핸들러 (Express 5 문법) ─────
app.get('/{*splat}', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ success: false, message: 'Internal server error' }); });

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
module.exports = app;
