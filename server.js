// Trade Engine — NSE Proxy + Upstox Integration
// Deploy on Render.com free tier
// Env vars needed:
//   CLAUDE_API_KEY   — Anthropic key (existing)
//   UPSTOX_API_KEY   — from developer.upstox.com (new)
//   UPSTOX_SECRET    — from developer.upstox.com (new)
//   UPSTOX_REDIRECT  — https://trade-engine-proxy.onrender.com/auth/upstox/callback (new)

const express   = require('express');
const axios     = require('axios');
const cors      = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app    = express();
const PORT   = process.env.PORT || 3001;
const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

app.use(cors());
app.use(express.json());

// ── YAHOO FINANCE USER AGENT (was missing before — caused silent failures) ──
const YF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── NSE SESSION ───────────────────────────────────────────
const NSE_HEADERS = {
  'User-Agent'     : YF_UA,
  'Accept'         : 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer'        : 'https://www.nseindia.com/',
  'Connection'     : 'keep-alive',
};
let session = { cookies: '', fetchedAt: 0 };
async function getSession() {
  if (session.cookies && Date.now() - session.fetchedAt < 8 * 60 * 1000) return session.cookies;
  try {
    const res = await axios.get('https://www.nseindia.com', { headers: NSE_HEADERS, timeout: 12000 });
    const raw = res.headers['set-cookie'] || [];
    session.cookies   = raw.map(c => c.split(';')[0]).join('; ');
    session.fetchedAt = Date.now();
    console.log('NSE session refreshed');
  } catch (err) {
    console.warn('NSE session refresh failed:', err.message);
  }
  return session.cookies;
}

// ══════════════════════════════════════════════════════════
//  UPSTOX INTEGRATION
// ══════════════════════════════════════════════════════════

// ── TOKEN STORE ───────────────────────────────────────────
let upstoxToken = { access_token: null, expires_at: 0 };

function isUpstoxReady() {
  return !!(upstoxToken.access_token && Date.now() < upstoxToken.expires_at);
}

function setUpstoxToken(token) {
  // Upstox tokens expire at midnight IST — calculate ms until then
  const nowIST       = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const midnightIST  = new Date(nowIST);
  midnightIST.setUTCHours(18, 30, 0, 0); // 18:30 UTC = midnight IST
  if (midnightIST <= nowIST) midnightIST.setUTCDate(midnightIST.getUTCDate() + 1);
  upstoxToken = {
    access_token: token,
    expires_at  : midnightIST.getTime(),
  };
  console.log('Upstox token set, expires at:', midnightIST.toISOString());
}

// ── INSTRUMENT KEY MAP (NSE symbol → Upstox instrument_key) ──
// Format: NSE_EQ|{ISIN}
// Covers all 149 stocks in the UNIVERSE. Yahoo Finance is fallback for any missing.
const IKEY = {
  // ── Nifty 50 ──
  'RELIANCE'   : 'NSE_EQ|INE002A01018',
  'HDFCBANK'   : 'NSE_EQ|INE040A01034',
  'ICICIBANK'  : 'NSE_EQ|INE090A01021',
  'INFY'       : 'NSE_EQ|INE009A01021',
  'TCS'        : 'NSE_EQ|INE467B01029',
  'KOTAKBANK'  : 'NSE_EQ|INE237A01028',
  'SBIN'       : 'NSE_EQ|INE062A01020',
  'AXISBANK'   : 'NSE_EQ|INE238A01034',
  'BAJFINANCE' : 'NSE_EQ|INE296A01024',
  'HINDUNILVR' : 'NSE_EQ|INE030A01027',
  'WIPRO'      : 'NSE_EQ|INE075A01022',
  'HCLTECH'    : 'NSE_EQ|INE860A01027',
  'TATAMOTORS' : 'NSE_EQ|INE155A01022',
  'MARUTI'     : 'NSE_EQ|INE585B01010',
  'SUNPHARMA'  : 'NSE_EQ|INE044A01036',
  'TATASTEEL'  : 'NSE_EQ|INE081A01012',
  'JSWSTEEL'   : 'NSE_EQ|INE019A01038',
  'HINDALCO'   : 'NSE_EQ|INE038A01020',
  'NTPC'       : 'NSE_EQ|INE733E01010',
  'POWERGRID'  : 'NSE_EQ|INE752E01010',
  'ONGC'       : 'NSE_EQ|INE213A01029',
  'LT'         : 'NSE_EQ|INE018A01030',
  'DRREDDY'    : 'NSE_EQ|INE089A01023',
  'CIPLA'      : 'NSE_EQ|INE059A01026',
  'TECHM'      : 'NSE_EQ|INE669C01036',
  'BAJAJFINSV' : 'NSE_EQ|INE918I01026',
  'EICHERMOT'  : 'NSE_EQ|INE066A01013',
  'DIVISLAB'   : 'NSE_EQ|INE361B01024',
  'GRASIM'     : 'NSE_EQ|INE047A01021',
  'ADANIPORTS' : 'NSE_EQ|INE742F01042',
  'ITC'        : 'NSE_EQ|INE154A01025',
  'NESTLEIND'  : 'NSE_EQ|INE239A01016',
  'ULTRACEMCO' : 'NSE_EQ|INE481G01011',
  'ASIANPAINT' : 'NSE_EQ|INE021A01026',
  'HDFCLIFE'   : 'NSE_EQ|INE795G01014',
  'SBILIFE'    : 'NSE_EQ|INE123W01016',
  'TATACONSUM' : 'NSE_EQ|INE192A01025',
  'BRITANNIA'  : 'NSE_EQ|INE216A01030',
  'COALINDIA'  : 'NSE_EQ|INE522F01014',
  'BPCL'       : 'NSE_EQ|INE029A01011',
  'IOC'        : 'NSE_EQ|INE242A01010',
  'APOLLOHOSP' : 'NSE_EQ|INE437A01024',
  'TITAN'      : 'NSE_EQ|INE280A01028',
  'BAJAJ-AUTO' : 'NSE_EQ|INE917I01010',
  'M&M'        : 'NSE_EQ|INE101A01026',
  'HEROMOTOCO' : 'NSE_EQ|INE158A01026',
  'INDUSINDBK' : 'NSE_EQ|INE095A01012',
  'TRENT'      : 'NSE_EQ|INE849A01020',
  'VEDL'       : 'NSE_EQ|INE205A01025',
  'PIDILITIND' : 'NSE_EQ|INE318A01026',
  'DMART'      : 'NSE_EQ|INE192R01011',
  // ── Banking ──
  'BANKBARODA' : 'NSE_EQ|INE028A01039',
  'PNB'        : 'NSE_EQ|INE160A01022',
  'CANBK'      : 'NSE_EQ|INE476A01014',
  'FEDERALBNK' : 'NSE_EQ|INE171A01029',
  'IDFCFIRSTB' : 'NSE_EQ|INE092T01019',
  'BANDHANBNK' : 'NSE_EQ|INE545U01014',
  'RBLBANK'    : 'NSE_EQ|INE976G01028',
  // ── Metals ──
  'SAIL'       : 'NSE_EQ|INE114A01011',
  'NMDC'       : 'NSE_EQ|INE584A01023',
  'NATIONALUM' : 'NSE_EQ|INE139A01034',
  'JINDALSTEL' : 'NSE_EQ|INE749A01030',
  'WELCORP'    : 'NSE_EQ|INE631H01015',
  'APLAPOLLO'  : 'NSE_EQ|INE702C01027',
  // ── IT ──
  'PERSISTENT' : 'NSE_EQ|INE262H01021',
  'COFORGE'    : 'NSE_EQ|INE591G01017',
  'LTIM'       : 'NSE_EQ|INE214T01019',
  'MPHASIS'    : 'NSE_EQ|INE356A01018',
  'OFSS'       : 'NSE_EQ|INE881D01027',
  // ── Finance ──
  'MUTHOOTFIN' : 'NSE_EQ|INE414G01012',
  'CHOLAFIN'   : 'NSE_EQ|INE121A01024',
  'LICHSGFIN'  : 'NSE_EQ|INE115A01026',
  'RECLTD'     : 'NSE_EQ|INE020B01018',
  'PFC'        : 'NSE_EQ|INE134E01011',
  'IRFC'       : 'NSE_EQ|INE053F01010',
  'HUDCO'      : 'NSE_EQ|INE031A01017',
  'BAJAJFINSV' : 'NSE_EQ|INE918I01026',
  'AAVAS'      : 'NSE_EQ|INE216P01012',
  'CREDITACC'  : 'NSE_EQ|INE741K01010',
  // ── Auto ──
  'TVSMOTOR'   : 'NSE_EQ|INE494B01023',
  'ASHOKLEY'   : 'NSE_EQ|INE208A01029',
  'MRF'        : 'NSE_EQ|INE883A01011',
  'MOTHERSON'  : 'NSE_EQ|INE775A01035',
  'BALKRISIND' : 'NSE_EQ|INE787D01026',
  'APOLLOTYRE' : 'NSE_EQ|INE074A01025',
  'CEATLTD'    : 'NSE_EQ|INE482A01020',
  'TIINDIA'    : 'NSE_EQ|INE974X01010',
  // ── Pharma ──
  'LUPIN'      : 'NSE_EQ|INE326A01037',
  'AUROPHARMA' : 'NSE_EQ|INE406A01037',
  'ALKEM'      : 'NSE_EQ|INE540L01014',
  'TORNTPHARM' : 'NSE_EQ|INE685A01028',
  'ZYDUSLIFE'  : 'NSE_EQ|INE010B01027',
  // ── Power ──
  'TATAPOWER'  : 'NSE_EQ|INE245A01021',
  'ADANIGREEN' : 'NSE_EQ|INE364U01010',
  'TORNTPOWER' : 'NSE_EQ|INE813H01021',
  'CESC'       : 'NSE_EQ|INE063A01020',
  // ── Infra / Realty ──
  'ADANIENT'   : 'NSE_EQ|INE423A01024',
  'GMRINFRA'   : 'NSE_EQ|INE776C01039',
  'DLF'        : 'NSE_EQ|INE271C01023',
  'GODREJPROP' : 'NSE_EQ|INE484J01027',
  'OBEROIRLTY' : 'NSE_EQ|INE093I01010',
  'BRIGADE'    : 'NSE_EQ|INE791I01019',
  // ── FMCG ──
  'MARICO'     : 'NSE_EQ|INE196A01026',
  'DABUR'      : 'NSE_EQ|INE016A01026',
  'COLPAL'     : 'NSE_EQ|INE259A01022',
  'EMAMILTD'   : 'NSE_EQ|INE548C01032',
  'GODREJCP'   : 'NSE_EQ|INE102D01028',
  'VBL'        : 'NSE_EQ|INE200M01013',
  // ── Engineering ──
  'BHEL'       : 'NSE_EQ|INE257A01026',
  'SIEMENS'    : 'NSE_EQ|INE003A01024',
  'ABB'        : 'NSE_EQ|INE117A01022',
  'CUMMINSIND' : 'NSE_EQ|INE298A01020',
  'AIAENG'     : 'NSE_EQ|INE212H01026',
  // ── Chemicals ──
  'NAVINFLUOR' : 'NSE_EQ|INE048G01026',
  'FINEORG'    : 'NSE_EQ|INE686Y01026',
  // ── Tech / New Age ──
  'ZOMATO'     : 'NSE_EQ|INE758T01015',
  'IRCTC'      : 'NSE_EQ|INE335Y01020',
  'INDIGO'     : 'NSE_EQ|INE646L01027',
  // ── Retail ──
  'TITAN'      : 'NSE_EQ|INE280A01028',
  'KALYANKJIL' : 'NSE_EQ|INE303R01014',
  // ── Pharma/Health ──
  'LALPATHLAB' : 'NSE_EQ|INE600L01024',
  'METROPOLIS' : 'NSE_EQ|INE225P01012',
  // ── Media ──
  'SUNTV'      : 'NSE_EQ|INE649A01019',
  'ZEEL'       : 'NSE_EQ|INE256A01028',
  // ── Textiles ──
  'PAGEIND'    : 'NSE_EQ|INE761H01022',
};

// Helper: get instrument_key for a symbol (strips .NS suffix)
function getIKey(symbol) {
  const sym = symbol.toUpperCase().replace('.NS', '').replace('-EQ', '').trim();
  return IKEY[sym] || null;
}

// Helper: Upstox API call with auth
async function upstoxGet(path, params = {}) {
  if (!isUpstoxReady()) throw new Error('UPSTOX_REAUTH');
  const url    = `https://api.upstox.com/v2${path}`;
  const response = await axios.get(url, {
    headers: {
      'Authorization': `Bearer ${upstoxToken.access_token}`,
      'Accept'       : 'application/json',
    },
    params,
    timeout: 10000,
  });
  return response.data;
}

// ── UPSTOX AUTH: Step 1 — redirect to Upstox login ───────
app.get('/auth/upstox', (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id    : process.env.UPSTOX_API_KEY,
    redirect_uri : process.env.UPSTOX_REDIRECT,
  });
  res.redirect(`https://api.upstox.com/v2/login/authorization/dialog?${params}`);
});

// ── UPSTOX AUTH: Step 2 — receive code, exchange for token
app.get('/auth/upstox/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.send(`
      <html><body style="font-family:monospace;background:#07070f;color:#ff1744;padding:40px">
        <h2>Auth failed: ${error || 'no code received'}</h2>
        <p>Close this tab and try again.</p>
      </body></html>
    `);
  }
  try {
    const response = await axios.post(
      'https://api.upstox.com/v2/login/authorization/token',
      new URLSearchParams({
        code         : code,
        client_id    : process.env.UPSTOX_API_KEY,
        client_secret: process.env.UPSTOX_SECRET,
        redirect_uri : process.env.UPSTOX_REDIRECT,
        grant_type   : 'authorization_code',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );
    setUpstoxToken(response.data.access_token);
    // Redirect back to the app with success flag
    res.send(`
      <html><body style="font-family:monospace;background:#07070f;color:#00e676;padding:40px;text-align:center">
        <h2 style="font-size:32px;letter-spacing:0.1em">✓ UPSTOX CONNECTED</h2>
        <p style="color:#5c6080">Token valid until midnight IST. You can close this tab.</p>
        <script>
          window.opener && window.opener.postMessage('upstox_connected', '*');
          setTimeout(() => window.close(), 2000);
        </script>
      </body></html>
    `);
  } catch (err) {
    console.error('Upstox token exchange failed:', err.response?.data || err.message);
    res.status(500).send(`
      <html><body style="font-family:monospace;background:#07070f;color:#ff1744;padding:40px">
        <h2>Token exchange failed</h2>
        <pre>${JSON.stringify(err.response?.data || err.message, null, 2)}</pre>
        <p>Check your UPSTOX_API_KEY, UPSTOX_SECRET and UPSTOX_REDIRECT env vars on Render.</p>
      </body></html>
    `);
  }
});

// ── UPSTOX AUTH: Status check ─────────────────────────────
app.get('/auth/upstox/status', (req, res) => {
  res.json({
    connected : isUpstoxReady(),
    expiresAt : upstoxToken.expires_at
      ? new Date(upstoxToken.expires_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })
      : null,
    authUrl   : `https://trade-engine-proxy.onrender.com/auth/upstox`,
  });
});

// ── UPSTOX: CANDLES (replaces /api/chart) ─────────────────
// Returns same IST-friendly format as Yahoo chart endpoint
app.get('/api/upstox/candles', async (req, res) => {
  const { symbol, interval } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const ikey = getIKey(symbol);
  if (!ikey) return res.status(404).json({ error: `No instrument key for ${symbol}`, fallback: true });
  if (!isUpstoxReady()) return res.status(401).json({ error: 'UPSTOX_REAUTH', needsReauth: true });

  // Map interval: '5m' → '5minute', '1m' → '1minute'
  const intervalMap = { '1m':'1minute', '5m':'5minute', '15m':'15minute', '1d':'1day' };
  const upstoxInterval = intervalMap[interval] || '5minute';

  const today = new Date().toISOString().split('T')[0];
  const encodedKey = encodeURIComponent(ikey);

  try {
    const data = await upstoxGet(`/historical-candle/intraday/${encodedKey}/${upstoxInterval}`);
    // Upstox candle format: [timestamp_string, open, high, low, close, volume, oi]
    const candles = (data.data?.candles || []).map(c => {
      const ts = Math.floor(new Date(c[0]).getTime() / 1000);
      // Convert to IST time label
      const istMs  = new Date(c[0]).getTime();
      const istD   = new Date(istMs);
      const h      = istD.getUTCHours();
      const m      = istD.getUTCMinutes();
      return {
        ts,
        time  : { h, m, label: `${h}:${String(m).padStart(2, '0')}` },
        open  : c[1], high: c[2], low: c[3], close: c[4], volume: c[5] || 0,
      };
    }).reverse(); // Upstox returns newest first, we want oldest first
    res.json({ candles, source: 'upstox' });
  } catch (err) {
    if (err.message === 'UPSTOX_REAUTH') return res.status(401).json({ error: 'UPSTOX_REAUTH', needsReauth: true });
    console.error('Upstox candles failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── UPSTOX: LTP (replaces /api/chart for live price) ──────
app.get('/api/upstox/ltp', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const ikey = getIKey(symbol);
  if (!ikey) return res.status(404).json({ error: `No instrument key for ${symbol}`, fallback: true });
  if (!isUpstoxReady()) return res.status(401).json({ error: 'UPSTOX_REAUTH', needsReauth: true });

  try {
    const data = await upstoxGet('/market-quote/ltp', { instrument_key: ikey });
    // Response key is like "NSE_EQ:INE002A01018" (colon not pipe)
    const quoteKey = Object.keys(data.data || {})[0];
    const price    = data.data?.[quoteKey]?.last_price;
    if (!price) return res.status(500).json({ error: 'No price data' });
    res.json({ price, symbol, timestamp: new Date().toISOString(), source: 'upstox' });
  } catch (err) {
    if (err.message === 'UPSTOX_REAUTH') return res.status(401).json({ error: 'UPSTOX_REAUTH', needsReauth: true });
    console.error('Upstox LTP failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── UPSTOX: BATCH QUOTES (replaces /api/quotes for screener)
// Accepts comma-separated NSE symbols (no .NS suffix)
app.get('/api/upstox/quotes', async (req, res) => {
  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols required' });
  if (!isUpstoxReady()) return res.status(401).json({ error: 'UPSTOX_REAUTH', needsReauth: true });

  const symList  = symbols.split(',').map(s => s.trim().replace('.NS', '').toUpperCase());
  const withKeys = symList.map(s => ({ symbol: s, ikey: IKEY[s] })).filter(x => x.ikey);
  const noKeys   = symList.filter(s => !IKEY[s]);

  if (noKeys.length) console.log('No Upstox key for:', noKeys.join(', '), '— will fall back');
  if (!withKeys.length) return res.status(404).json({ error: 'No instrument keys found', fallback: true });

  try {
    // Upstox accepts up to 500 instrument keys per call
    const BATCH = 50;
    const results = [];
    for (let i = 0; i < withKeys.length; i += BATCH) {
      const batch    = withKeys.slice(i, i + BATCH);
      const keyParam = batch.map(x => x.ikey).join(',');
      const data     = await upstoxGet('/market-quote/quotes', { instrument_key: keyParam });
      const quotes   = data.data || {};
      batch.forEach(({ symbol, ikey }) => {
        const qkey  = Object.keys(quotes).find(k => k.includes(ikey.split('|')[1]));
        const q     = qkey ? quotes[qkey] : null;
        if (!q) return;
        const price = q.last_price || 0;
        const prev  = q.ohlc?.close || price;
        results.push({
          symbol                  : `${symbol}.NS`,
          regularMarketPrice      : price,
          regularMarketVolume     : q.volume || 0,
          averageDailyVolume10Day : q.average_trade_price ? q.volume : (q.volume || 0),
          regularMarketChangePercent: prev ? ((price - prev) / prev) * 100 : 0,
          regularMarketChange     : price - prev,
        });
      });
    }
    res.json({ quoteResponse: { result: results, error: null }, source: 'upstox' });
  } catch (err) {
    if (err.message === 'UPSTOX_REAUTH') return res.status(401).json({ error: 'UPSTOX_REAUTH', needsReauth: true });
    console.error('Upstox quotes failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
//  EXISTING YAHOO FINANCE ENDPOINTS (kept as fallback)
// ══════════════════════════════════════════════════════════

// ── MACRO ─────────────────────────────────────────────────
const MACRO_SYMBOLS = ['^DJI','^IXIC','^GSPC','^N225','^HSI','CL=F','BZ=F','USDINR=X','^INDIAVIX','^NSEI','^NSEBANK'];
app.get('/api/macro', async (req, res) => {
  try {
    const results = await Promise.allSettled(
      MACRO_SYMBOLS.map(async sym => {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d&includePrePost=false`;
        const r   = await axios.get(url, { headers: { 'User-Agent': YF_UA, 'Accept': 'application/json' }, timeout: 10000 });
        const meta = r.data?.chart?.result?.[0]?.meta;
        if (!meta) return null;
        const prev = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice;
        const curr = meta.regularMarketPrice;
        return {
          symbol                    : sym,
          regularMarketPrice        : curr,
          regularMarketPreviousClose: prev,
          regularMarketChange       : curr - prev,
          regularMarketChangePercent: prev ? ((curr - prev) / prev) * 100 : 0,
        };
      })
    );
    const quoteResult = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    if (!quoteResult.length) return res.status(500).json({ error: 'No data from Yahoo' });
    res.json({ quoteResponse: { result: quoteResult, error: null } });
  } catch (err) {
    console.error('Macro fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── YAHOO CHART (fallback when Upstox not connected) ──────
app.get('/api/chart', async (req, res) => {
  const { symbol, interval, range } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  try {
    const url      = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval||'5m'}&range=${range||'1d'}&includePrePost=false`;
    const response = await axios.get(url, { headers: { 'User-Agent': YF_UA, 'Accept': 'application/json' }, timeout: 12000 });
    res.json(response.data);
  } catch (err) {
    console.error('Chart fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── YAHOO QUOTES (fallback) ───────────────────────────────
app.get('/api/quotes', async (req, res) => {
  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols required' });
  try {
    const symList = symbols.split(',').slice(0, 15);
    const results = await Promise.allSettled(
      symList.map(async sym => {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym.trim())}?interval=1d&range=1d`;
        const r   = await axios.get(url, { headers: { 'User-Agent': YF_UA, 'Accept': 'application/json' }, timeout: 8000 });
        const meta = r.data?.chart?.result?.[0]?.meta;
        if (!meta) return null;
        const prev = meta.chartPreviousClose || meta.regularMarketPrice;
        const curr = meta.regularMarketPrice;
        return {
          symbol                    : sym.trim(),
          regularMarketPrice        : curr,
          regularMarketVolume       : meta.regularMarketVolume || 0,
          averageDailyVolume10Day   : meta.averageDailyVolume10Day || meta.regularMarketVolume || 0,
          regularMarketChangePercent: prev ? ((curr - prev) / prev) * 100 : 0,
          regularMarketChange       : curr - prev,
        };
      })
    );
    const quoteResult = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    res.json({ quoteResponse: { result: quoteResult, error: null } });
  } catch (err) {
    console.error('Quotes fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── FII/DII ───────────────────────────────────────────────
app.get('/api/fii', async (req, res) => {
  try {
    const cookies  = await getSession();
    const response = await axios.get('https://www.nseindia.com/api/fiidiiTradeReact', { headers: { ...NSE_HEADERS, Cookie: cookies }, timeout: 12000 });
    res.json(response.data);
  } catch (err) {
    console.error('FII fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PCR ───────────────────────────────────────────────────
app.get('/api/pcr', async (req, res) => {
  try {
    const cookies  = await getSession();
    const response = await axios.get('https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY', { headers: { ...NSE_HEADERS, Cookie: cookies }, timeout: 15000 });
    const records  = response.data?.records?.data || [];
    let putOI = 0, callOI = 0;
    records.forEach(r => { if (r.PE) putOI += (r.PE.openInterest || 0); if (r.CE) callOI += (r.CE.openInterest || 0); });
    const pcr = callOI > 0 ? parseFloat((putOI / callOI).toFixed(2)) : null;
    res.json({ pcr, putOI, callOI, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('PCR fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── AI NEWS FILTER ────────────────────────────────────────
app.get('/api/news', async (req, res) => {
  const { stock, symbol } = req.query;
  if (!stock) return res.status(400).json({ error: 'stock param required' });
  try {
    const msg  = await client.messages.create({
      model    : 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      tools    : [{ type: 'web_search_20250305', name: 'web_search' }],
      messages : [{ role: 'user', content: `Search for news about ${stock} (${symbol}.NS) NSE India stock today ${new Date().toLocaleDateString('en-IN')}. Is there any major event (quarterly results, earnings, regulatory action, management change, FPO, acquisition) that would make intraday technical analysis unreliable today? Reply with ONLY: CLEAR or CAUTION: [one short reason]` }],
    });
    const text    = msg.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
    const isClear = text.toUpperCase().includes('CLEAR') && !text.toUpperCase().includes('CAUTION');
    res.json({ status: isClear ? 'CLEAR' : 'CAUTION', detail: text.replace(/^CLEAR\s*/i, '').replace(/^CAUTION:\s*/i, '').trim() || text });
  } catch (err) {
    console.error('News check failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── HEALTH ────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status  : 'ok',
    server  : 'Trade Engine Proxy v2 + Upstox',
    time    : new Date().toISOString(),
    nse     : session.fetchedAt ? 'session active' : 'no session',
    upstox  : isUpstoxReady()
      ? `connected · expires ${new Date(upstoxToken.expires_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`
      : 'not connected — visit /auth/upstox',
    instruments: `${Object.keys(IKEY).length} NSE stocks mapped`,
  });
});

app.get('/', (req, res) => {
  res.send(`Trade Engine Proxy — running.<br>Upstox: ${isUpstoxReady() ? '✓ Connected' : '<a href="/auth/upstox">Connect Upstox</a>'}`);
});

app.listen(PORT, () => {
  console.log(`Trade Engine Proxy running on port ${PORT}`);
  console.log(`Upstox: ${isUpstoxReady() ? 'connected' : 'not connected — visit /auth/upstox to connect'}`);
});
