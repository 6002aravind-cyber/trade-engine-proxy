// Trade Engine — NSE FII/DII Proxy Server
// Fetches FII data from NSE with proper session cookies
// Deploy on Render.com free tier
 
const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
 
const app    = express();
const PORT   = process.env.PORT || 3001;
const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
 
app.use(cors()); // Allow requests from your Vercel app
 
// NSE requires real browser headers + session cookies
const NSE_HEADERS = {
  'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept'          : 'application/json, text/plain, */*',
  'Accept-Language' : 'en-US,en;q=0.9',
  'Accept-Encoding' : 'gzip, deflate, br',
  'Referer'         : 'https://www.nseindia.com/',
  'Connection'      : 'keep-alive',
};
 
// Session cache — refresh cookies every 8 minutes
let session = { cookies: '', fetchedAt: 0 };
 
async function getSession() {
  const age = Date.now() - session.fetchedAt;
  if (session.cookies && age < 8 * 60 * 1000) return session.cookies;
 
  try {
    const res = await axios.get('https://www.nseindia.com', {
      headers: NSE_HEADERS,
      timeout: 12000,
    });
    const raw = res.headers['set-cookie'] || [];
    session.cookies  = raw.map(c => c.split(';')[0]).join('; ');
    session.fetchedAt = Date.now();
    console.log('NSE session refreshed');
  } catch (err) {
    console.warn('Session refresh failed, using cached:', err.message);
  }
  return session.cookies;
}
 
// ── YAHOO FINANCE SESSION ─────────────────────────────────
const YF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
let yfSession = { cookies: '', crumb: '', fetchedAt: 0 };
 
async function getYahooCrumb() {
  const age = Date.now() - yfSession.fetchedAt;
  if (yfSession.crumb && age < 50 * 60 * 1000) return yfSession;
  try {
    const c1 = await axios.get('https://fc.yahoo.com', {
      headers: { 'User-Agent': YF_UA },
      timeout: 10000, maxRedirects: 5,
    });
    const cookies = (c1.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const c2 = await axios.get('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': YF_UA, 'Cookie': cookies },
      timeout: 10000,
    });
    yfSession = { cookies, crumb: c2.data, fetchedAt: Date.now() };
    console.log('Yahoo crumb refreshed');
  } catch (err) {
    console.warn('Yahoo crumb failed:', err.message);
  }
  return yfSession;
}
 
// ── YAHOO FINANCE MACRO endpoint ─────────────────────────
const YAHOO_SYMS = '^DJI,^IXIC,^GSPC,^N225,^HSI,CL=F,BZ=F,USDINR=X,^INDIAVIX,^NSEI,^NSEBANK';
app.get('/api/macro', async (req, res) => {
  try {
    const { cookies, crumb } = await getYahooCrumb();
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(YAHOO_SYMS)}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose${crumb?`&crumb=${encodeURIComponent(crumb)}`:''}`;
    const response = await axios.get(url, {
      headers: { 'User-Agent': YF_UA, 'Accept': 'application/json', 'Cookie': cookies },
      timeout: 12000,
    });
    res.json(response.data);
  } catch (err) {
    console.error('Macro fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});
 
// ── YAHOO FINANCE CHART endpoint ──────────────────────────
app.get('/api/chart', async (req, res) => {
  const { symbol, interval, range } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  try {
    const { cookies, crumb } = await getYahooCrumb();
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval||'5m'}&range=${range||'1d'}&includePrePost=false${crumb?`&crumb=${encodeURIComponent(crumb)}`:''}`;
    const response = await axios.get(url, {
      headers: { 'User-Agent': YF_UA, 'Accept': 'application/json', 'Cookie': cookies },
      timeout: 12000,
    });
    res.json(response.data);
  } catch (err) {
    console.error('Chart fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});
 
// ── YAHOO FINANCE SCREENER QUOTES endpoint ────────────────
app.get('/api/quotes', async (req, res) => {
  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols required' });
  try {
    const { cookies, crumb } = await getYahooCrumb();
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,regularMarketVolume,averageDailyVolume10Day,regularMarketChangePercent,regularMarketChange${crumb?`&crumb=${encodeURIComponent(crumb)}`:''}`;
    const response = await axios.get(url, {
      headers: { 'User-Agent': YF_UA, 'Accept': 'application/json', 'Cookie': cookies },
      timeout: 12000,
    });
    res.json(response.data);
  } catch (err) {
    console.error('Quotes fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/fii', async (req, res) => {
  try {
    const cookies  = await getSession();
    const response = await axios.get(
      'https://www.nseindia.com/api/fiidiiTradeReact',
      { headers: { ...NSE_HEADERS, Cookie: cookies }, timeout: 12000 }
    );
    res.json(response.data);
  } catch (err) {
    console.error('FII fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});
 
// ── Health check ──────────────────────────────────────────
// ── PCR (Put-Call Ratio) endpoint ────────────────────────
app.get('/api/pcr', async (req, res) => {
  try {
    const cookies  = await getSession();
    const response = await axios.get(
      'https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY',
      { headers: { ...NSE_HEADERS, Cookie: cookies }, timeout: 15000 }
    );
    const records = response.data?.records?.data || [];
    let putOI = 0, callOI = 0;
    records.forEach(r => {
      if (r.PE) putOI  += (r.PE.openInterest || 0);
      if (r.CE) callOI += (r.CE.openInterest || 0);
    });
    const pcr = callOI > 0 ? parseFloat((putOI / callOI).toFixed(2)) : null;
    res.json({ pcr, putOI, callOI, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('PCR fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});
 
// ── AI NEWS FILTER endpoint ───────────────────────────────
app.get('/api/news', async (req, res) => {
  const { stock, symbol } = req.query;
  if (!stock) return res.status(400).json({ error: 'stock param required' });
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `Search for news about ${stock} (${symbol}.NS) NSE India stock today ${new Date().toLocaleDateString('en-IN')}. Is there any major event (quarterly results, earnings, regulatory action, management change, FPO, acquisition) that would make intraday technical analysis unreliable today? Reply with ONLY: CLEAR or CAUTION: [one short reason]`
      }]
    });
    const text = msg.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
    const isClear = text.toUpperCase().includes('CLEAR') && !text.toUpperCase().includes('CAUTION');
    res.json({
      status: isClear ? 'CLEAR' : 'CAUTION',
      detail: text.replace(/^CLEAR\s*/i, '').replace(/^CAUTION:\s*/i, '').trim() || text,
    });
  } catch (err) {
    console.error('News check failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});
 
app.get('/health', (req, res) => {
  res.json({
    status   : 'ok',
    server   : 'Trade Engine FII Proxy',
    time     : new Date().toISOString(),
    session  : session.fetchedAt ? 'active' : 'none',
  });
});
 
app.get('/', (req, res) => {
  res.send('Trade Engine FII Proxy — running. Use /api/fii for data.');
});
 
app.listen(PORT, () => {
  console.log(`FII Proxy running on port ${PORT}`);
});
 
