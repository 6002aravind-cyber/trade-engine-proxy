// Trade Engine — NSE FII/DII Proxy Server
// Fetches FII data from NSE with proper session cookies
// Deploy on Render.com free tier

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3001;

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

// ── FII/DII endpoint ──────────────────────────────────────
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
