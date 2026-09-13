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
const PORT = process.env.PORT || 4004;
const START_CASH = 1000000;
const UPBIT_TICKER_URL = 'https://api.upbit.com/v1/ticker';
const UPBIT_CANDLE_URL = 'https://api.upbit.com/v1/candles/minutes';

// Supabase 연결 (SSL 필요)
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── wallet / orders 테이블 준비 (없으면 생성) ─────
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet (
      id INTEGER PRIMARY KEY DEFAULT 1,
      cash NUMERIC NOT NULL DEFAULT ${START_CASH},
      holdings JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await pool.query(
    `INSERT INTO wallet (id, cash, holdings) VALUES (1, ${START_CASH}, '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      market TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
      amount NUMERIC NOT NULL,
      price NUMERIC NOT NULL,
      memo TEXT NOT NULL
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

// ── Upbit 공개 API 헬퍼 (키 필요 없음) ─────────
async function fetchUpbitPrices(markets) {
  const url = `${UPBIT_TICKER_URL}?markets=${encodeURIComponent(markets.join(','))}`;
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) {
    const message = (body && body.error && body.error.message) || 'Upbit API 조회 실패';
    throw new Error(message);
  }
  const priceMap = {};
  for (const ticker of body) {
    priceMap[ticker.market] = ticker;
  }
  return priceMap;
}

async function fetchSinglePrice(market) {
  const priceMap = await fetchUpbitPrices([market]);
  const ticker = priceMap[market];
  if (!ticker) {
    throw new Error(`알 수 없는 마켓: ${market}`);
  }
  return ticker;
}

async function fetchUpbitCandles(market, unit, count) {
  const url = `${UPBIT_CANDLE_URL}/${unit}?market=${encodeURIComponent(market)}&count=${count}`;
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) {
    const message = (body && body.error && body.error.message) || '캔들 조회 실패';
    throw new Error(message);
  }
  // Upbit는 최신순으로 내려주므로 차트용으로 오래된 순으로 뒤집는다
  return body
    .slice()
    .reverse()
    .map((c) => ({
      time: c.candle_date_time_kst,
      open: c.opening_price,
      high: c.high_price,
      low: c.low_price,
      close: c.trade_price,
      volume: c.candle_acc_trade_volume,
    }));
}

// ── API routes ───────────────────────────────

// 조회: 현재가
app.get('/api/price', async (req, res) => {
  try {
    const { market } = req.query;
    if (!market || !String(market).trim()) {
      return res.status(400).json({ success: false, message: 'market is required' });
    }
    const ticker = await fetchSinglePrice(String(market).trim());
    res.json({
      success: true,
      data: {
        market: ticker.market,
        trade_price: ticker.trade_price,
        change: ticker.change,
        change_rate: ticker.change_rate,
        signed_change_rate: ticker.signed_change_rate,
        high_price: ticker.high_price,
        low_price: ticker.low_price,
        timestamp: ticker.timestamp,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: err.message || '현재가 조회 실패' });
  }
});

// 조회: 지갑 (현금 + 보유 코인 평가금액 + 평균 매수가 + 수익률)
app.get('/api/wallet', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM wallet WHERE id = 1');
    const wallet = result.rows[0];
    const holdings = wallet.holdings || {};
    const heldMarkets = Object.keys(holdings).filter((m) => Number(holdings[m].amount) > 0);

    let evaluation = 0;
    const holdingsDetail = {};
    if (heldMarkets.length > 0) {
      const priceMap = await fetchUpbitPrices(heldMarkets);
      for (const market of heldMarkets) {
        const qty = Number(holdings[market].amount);
        const avgPrice = Number(holdings[market].avgPrice);
        const price = priceMap[market] ? priceMap[market].trade_price : 0;
        const value = qty * price;
        const unrealizedPnl = (price - avgPrice) * qty;
        const unrealizedPnlRate = avgPrice > 0 ? (price - avgPrice) / avgPrice : 0;
        evaluation += value;
        holdingsDetail[market] = { amount: qty, avgPrice, price, value, unrealizedPnl, unrealizedPnlRate };
      }
    }

    const cash = Number(wallet.cash);
    const total = cash + evaluation;
    const profit_rate = (total - START_CASH) / START_CASH;

    res.json({
      success: true,
      data: {
        cash,
        holdings: holdingsDetail,
        evaluation,
        total,
        profit_rate,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '지갑 조회 실패' });
  }
});

// 조회: 캔들 차트 데이터 (기본 1시간봉 200개)
app.get('/api/candles', async (req, res) => {
  try {
    const { market, unit = '60', count = '200' } = req.query;
    if (!market || !String(market).trim()) {
      return res.status(400).json({ success: false, message: 'market is required' });
    }
    const candleCount = Math.min(Number(count) || 200, 200);
    const candles = await fetchUpbitCandles(String(market).trim(), String(unit).trim(), candleCount);
    res.json({ success: true, data: candles });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: err.message || '캔들 조회 실패' });
  }
});

// 조회: 주문 내역
app.get('/api/orders', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '주문 내역 조회 실패' });
  }
});

// 생성: 매수/매도 주문
app.post('/api/order', async (req, res) => {
  const { market, side, amount, memo } = req.body || {};

  if (!market || !String(market).trim()) {
    return res.status(400).json({ success: false, message: 'market is required' });
  }
  if (side !== 'buy' && side !== 'sell') {
    return res.status(400).json({ success: false, message: "side는 'buy' 또는 'sell'이어야 합니다" });
  }
  const qty = Number(amount);
  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ success: false, message: '유효한 amount(수량)가 필요합니다' });
  }
  if (!memo || !String(memo).trim()) {
    return res.status(400).json({ success: false, message: '매수/매도 이유(memo)는 필수입니다' });
  }

  const marketCode = String(market).trim();
  const client = await pool.connect();
  try {
    let ticker;
    try {
      ticker = await fetchSinglePrice(marketCode);
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message || '현재가 조회 실패' });
    }
    const price = ticker.trade_price;
    const cost = price * qty;

    await client.query('BEGIN');
    const walletResult = await client.query('SELECT * FROM wallet WHERE id = 1 FOR UPDATE');
    const wallet = walletResult.rows[0];
    const cash = Number(wallet.cash);
    const holdings = { ...(wallet.holdings || {}) };
    const existing = holdings[marketCode];
    const currentQty = existing ? Number(existing.amount) : 0;
    const currentAvgPrice = existing ? Number(existing.avgPrice) : 0;

    if (side === 'buy') {
      if (cash < cost) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: '현금이 부족합니다' });
      }
      const newQty = currentQty + qty;
      // 매수 시 가중평균으로 평단가(avgPrice) 갱신
      const newAvgPrice = (currentQty * currentAvgPrice + qty * price) / newQty;
      holdings[marketCode] = { amount: newQty, avgPrice: newAvgPrice };
      const newCash = cash - cost;

      await client.query('UPDATE wallet SET cash = $1, holdings = $2 WHERE id = 1', [
        newCash,
        JSON.stringify(holdings),
      ]);
    } else {
      if (currentQty < qty) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: '보유 수량이 부족합니다' });
      }
      const remaining = currentQty - qty;
      if (remaining > 0) {
        // 매도는 평단가(avgPrice)를 그대로 유지 (남은 수량의 원가 기준)
        holdings[marketCode] = { amount: remaining, avgPrice: currentAvgPrice };
      } else {
        delete holdings[marketCode];
      }
      const newCash = cash + cost;

      await client.query('UPDATE wallet SET cash = $1, holdings = $2 WHERE id = 1', [
        newCash,
        JSON.stringify(holdings),
      ]);
    }

    const orderResult = await client.query(
      `INSERT INTO orders (market, side, amount, price, memo) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [marketCode, side, qty, price, String(memo).trim()]
    );

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: orderResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: '주문 처리 실패' });
  } finally {
    client.release();
  }
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
module.exports = app;
