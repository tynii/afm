require('dotenv').config({ quiet: true });
const express = require('express');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// ── DB (처음 API 요청 때 한 번만 테이블 준비) ──
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wishes (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT,
      image_url TEXT,
      category TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query('ALTER TABLE wishes ADD COLUMN IF NOT EXISTS memo TEXT');
  dbInitialized = true;
}

app.use('/api', async (_req, res, next) => {
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('DB init failed:', err);
    res.status(500).json({ success: false, message: 'DB 연결에 실패했어요.' });
  }
});

// ── 위시 API ──
const CATEGORIES = ['문화', '콘텐츠', '장소', '음식', '상품', '기타'];

// 비어 있으면 null, http/https 주소면 그대로, 그 외는 false
function cleanUrl(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length > 2000) return false;
  try {
    const { protocol } = new URL(text);
    return protocol === 'http:' || protocol === 'https:' ? text : false;
  } catch {
    return false;
  }
}

const COLUMNS = 'id, title, url, image_url, category, memo, created_at';

// 담기·수정에 공통으로 쓰는 입력 검사. 문제가 있으면 { error }, 없으면 { values }
function validateWish(body = {}) {
  const title = String(body.title || '').trim();
  const category = String(body.category || '');
  const url = cleanUrl(body.url);
  const imageUrl = cleanUrl(body.image_url);
  const memo = String(body.memo || '').trim();
  if (!title) return { error: '제목을 입력해 주세요.' };
  if (title.length > 200) return { error: '제목은 200자까지 입력할 수 있어요.' };
  if (!CATEGORIES.includes(category)) return { error: '카테고리를 선택해 주세요.' };
  if (url === false) return { error: '링크는 http:// 또는 https://로 시작해야 해요.' };
  if (imageUrl === false) return { error: '이미지 주소는 http:// 또는 https://로 시작해야 해요.' };
  if (memo.length > 1000) return { error: '메모는 1000자까지 입력할 수 있어요.' };
  return { values: [title, url, imageUrl, category, memo || null] };
}

// 숫자 id가 아니면 null
function parseId(value) {
  return /^\d{1,9}$/.test(value) ? Number(value) : null;
}

app.get('/api/wishes', async (_req, res) => {
  try {
    const result = await pool.query(`SELECT ${COLUMNS} FROM wishes ORDER BY created_at DESC`);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '위시를 불러오지 못했어요.' });
  }
});

app.get('/api/wishes/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const result = id && (await pool.query(`SELECT ${COLUMNS} FROM wishes WHERE id = $1`, [id]));
    if (!result || !result.rows[0]) {
      return res.status(404).json({ success: false, message: '위시를 찾을 수 없어요.' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '위시를 불러오지 못했어요.' });
  }
});

app.post('/api/wishes', async (req, res) => {
  try {
    const { error, values } = validateWish(req.body);
    if (error) return res.status(400).json({ success: false, message: error });
    const result = await pool.query(
      `INSERT INTO wishes (title, url, image_url, category, memo) VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
      values
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '저장하지 못했어요.' });
  }
});

app.put('/api/wishes/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const { error, values } = validateWish(req.body);
    if (error) return res.status(400).json({ success: false, message: error });
    const result =
      id &&
      (await pool.query(
        `UPDATE wishes SET title = $1, url = $2, image_url = $3, category = $4, memo = $5 WHERE id = $6 RETURNING ${COLUMNS}`,
        [...values, id]
      ));
    if (!result || !result.rows[0]) {
      return res.status(404).json({ success: false, message: '위시를 찾을 수 없어요.' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '수정하지 못했어요.' });
  }
});

app.delete('/api/wishes/:id', async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const result = id && (await pool.query('DELETE FROM wishes WHERE id = $1', [id]));
    if (!result || result.rowCount === 0) {
      return res.status(404).json({ success: false, message: '위시를 찾을 수 없어요.' });
    }
    res.json({ success: true, data: { id } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '삭제하지 못했어요.' });
  }
});

// ── 링크 미리보기: 페이지의 og:title·og:image를 읽어 온다 ──
// 안전장치: http/https만, 내부망 주소 차단, 리다이렉트 3번까지, 5초 타임아웃, 1MB까지만 읽기
const PREVIEW_TIMEOUT_MS = 5000;
const PREVIEW_MAX_BYTES = 1024 * 1024;
const PREVIEW_MAX_REDIRECTS = 3;
const PREVIEW_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const privateIps = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
].forEach(([ip, prefix]) => privateIps.addSubnet(ip, prefix, 'ipv4'));
[['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]].forEach(([ip, prefix]) =>
  privateIps.addSubnet(ip, prefix, 'ipv6')
);

async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('blocked host');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  for (const { address } of addresses) {
    const ip = address.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
    if (privateIps.check(ip, net.isIP(ip) === 6 ? 'ipv6' : 'ipv4')) throw new Error('blocked host');
  }
}

// 리다이렉트를 직접 따라가면서 매번 주소를 검사한다
async function fetchPublicPage(startUrl, signal) {
  let current = startUrl;
  for (let i = 0; i <= PREVIEW_MAX_REDIRECTS; i++) {
    const target = new URL(current);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('bad protocol');
    await assertPublicHost(target.hostname);
    const res = await fetch(target, {
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': PREVIEW_USER_AGENT,
        // 브라우저 기본값. 'text/html,application/xhtml+xml'만 보내면 오늘의집 상품 페이지가 404를 준다
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, target).href;
      continue;
    }
    return { res, finalUrl: target.href };
  }
  throw new Error('too many redirects');
}

async function readLimited(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < PREVIEW_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, PREVIEW_MAX_BYTES);
}

// EUC-KR 같은 한국 사이트 인코딩도 처리한다
function decodeHtml(buffer, contentType) {
  const head = buffer.subarray(0, 4096).toString('latin1');
  const charset =
    (contentType.match(/charset=["']?([\w-]+)/i) || head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1] ||
    'utf-8';
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_m, code) => {
    if (code[0] !== '#') return named[code.toLowerCase()];
    const num = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return String.fromCodePoint(num);
  });
}

function parseMeta(html) {
  const meta = {};
  for (const [tag] of html.matchAll(/<meta\s[^>]*>/gi)) {
    const attrs = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
    }
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content && !(key in meta)) meta[key] = attrs.content;
  }
  const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  return { meta, titleTag };
}

// "상품명 - 모든 취향 곁에, 29CM"처럼 끝에 붙은 사이트 이름을 뗀다.
// 마지막 " - " / " | " / " : " 뒤 부분이 도메인 이름(29cm)이나 og:site_name과 겹칠 때만 자른다
function stripSiteName(title, pageUrl, meta) {
  const match = title.match(/^(.+?)\s+[-|–—:]\s+([^-|–—:]+)$/);
  if (!match) return title;
  const tail = match[2].toLowerCase();
  // 29cm.co.kr → ['29cm'], en.wikipedia.org → ['wikipedia']
  const brands = new URL(pageUrl).hostname
    .split('.')
    .filter((label) => label.length >= 3 && !['www', 'com', 'net', 'org'].includes(label));
  const siteName = (meta['og:site_name'] || '').toLowerCase();
  // 네이버: 제목 끝 "네이버" ⊂ og:site_name "네이버 플레이스"
  const isSiteName =
    brands.some((brand) => tail.includes(brand)) ||
    (siteName && (tail.includes(siteName) || (tail.length >= 2 && siteName.includes(tail))));
  return isSiteName ? match[1].trim() : title;
}

app.get('/api/preview', async (req, res) => {
  const url = cleanUrl(req.query.url);
  if (!url) {
    return res.status(400).json({ success: false, message: '올바른 링크를 입력해 주세요.' });
  }
  try {
    const { res: page, finalUrl } = await fetchPublicPage(url, AbortSignal.timeout(PREVIEW_TIMEOUT_MS));
    const contentType = page.headers.get('content-type') || '';
    if (!page.ok || !contentType.includes('html')) throw new Error(`status ${page.status}`);

    const html = decodeHtml(await readLimited(page), contentType);
    const { meta, titleTag } = parseMeta(html);

    const rawTitle = meta['og:title'] || meta['twitter:title'] || titleTag || '';
    // 제어문자(네이버 제목 끝의 \u001c 등)는 지우고 공백은 하나로 줄인다
    const cleanTitle = decodeEntities(rawTitle).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    const title = stripSiteName(cleanTitle, finalUrl, meta).slice(0, 200);

    const rawImage = meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'];
    let imageUrl = null;
    if (rawImage) {
      const resolved = cleanUrl(new URL(decodeEntities(rawImage).trim(), finalUrl).href);
      if (resolved) imageUrl = resolved;
    }

    if (!title && !imageUrl) throw new Error('no meta');
    res.json({ success: true, data: { title, image_url: imageUrl } });
  } catch (err) {
    console.error('preview failed:', url, err.message);
    res.status(422).json({ success: false, message: '이 링크는 정보를 불러올 수 없어요. 직접 입력해 주세요.' });
  }
});

// ── 화면: index.html 하나만 내보낸다 (폴더 전체를 공개하지 않음) ──
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
module.exports = app;
