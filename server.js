// Trade Engine — NSE Proxy + Upstox Integration
// Deploy on Render.com free tier
// Env vars needed:
//   CLAUDE_API_KEY   — Anthropic key (existing)
//   GROK_API_KEY     — xAI Grok key (free at console.x.ai)
//   UPSTOX_API_KEY   — from developer.upstox.com
//   UPSTOX_SECRET    — from developer.upstox.com
//   UPSTOX_REDIRECT  — https://trade-engine-proxy.onrender.com/auth/upstox/callback

const express   = require('express');
const axios     = require('axios');
const cors      = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app    = express();
const PORT   = process.env.PORT || 3001;
const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

// ── DUAL AI — Claude (primary) + Grok (fallback/parallel) ──
const grokEnabled = !!process.env.GROK_API_KEY;

const callGrok = async (prompt, maxTokens = 1000) => {
  if (!grokEnabled) throw new Error('Grok not configured');
  const r = await axios.post('https://api.x.ai/v1/chat/completions', {
    model: 'grok-3-mini',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  }, {
    headers: { 'Authorization': `Bearer ${process.env.GROK_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
  return r.data.choices?.[0]?.message?.content || '';
};

const callClaude = async (prompt, maxTokens = 1000, tools = null) => {
  const params = {
    model: 'claude-haiku-4-5',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (tools) params.tools = tools;
  const msg = await client.messages.create(params);
  return msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
};

// Try Claude first, fall back to Grok if credits exhausted
const callAI = async (prompt, maxTokens = 1000, tools = null) => {
  try {
    const text = await callClaude(prompt, maxTokens, tools);
    return { text, source: 'claude' };
  } catch (e) {
    const isCredit = e.status === 400 || e.message?.includes('credit');
    if (isCredit && grokEnabled) {
      console.log('Claude credits exhausted — falling back to Grok');
      const text = await callGrok(prompt, maxTokens);
      return { text, source: 'grok' };
    }
    throw e;
  }
};

app.use(cors());
app.use(express.json());

// ── SUPABASE (for token persistence) ─────────────────────
const SB_URL = 'https://wyifvgcyqdzrllezpnmx.supabase.co';
const SB_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind5aWZ2Z2N5cWR6cmxsZXpwbm14Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1OTI3MDQsImV4cCI6MjA5NTE2ODcwNH0.WA2Ke7xhd79AUudwu1IkEOogwxbhnHIjVYyE2WItbVw';
const SB_HEADERS = { 'Content-Type':'application/json', 'apikey':SB_KEY, 'Authorization':`Bearer ${SB_KEY}` };

async function saveTokenToSupabase(token, expiresAt) {
  try {
    await axios.post(`${SB_URL}/rest/v1/settings`,
      { key:'upstox_token', value:token, expires_at:new Date(expiresAt).toISOString() },
      { headers:{ ...SB_HEADERS, 'Prefer':'resolution=merge-duplicates' } }
    );
    console.log('Upstox token saved to Supabase');
  } catch(err) { console.warn('Failed to save token to Supabase:', err.message); }
}

async function loadTokenFromSupabase() {
  try {
    const res  = await axios.get(`${SB_URL}/rest/v1/settings?key=eq.upstox_token`, { headers:SB_HEADERS });
    const row  = res.data?.[0];
    if (!row?.value) return null;
    const expiresAt = new Date(row.expires_at).getTime();
    if (Date.now() >= expiresAt) { console.log('Supabase token expired'); return null; }
    console.log('Upstox token loaded from Supabase ✓');
    return { token: row.value, expiresAt };
  } catch(err) { console.warn('Failed to load token from Supabase:', err.message); return null; }
}

// ── YAHOO FINANCE USER AGENT (was missing before — caused silent failures) ──
const YF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const YF_HEADERS = {
  'User-Agent': YF_UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Origin': 'https://finance.yahoo.com',
  'Referer': 'https://finance.yahoo.com/',
};

// ── Yahoo Finance crumb (required since 2024) ─────────────
let yfCrumb = null;
let yfCookie = null;
let yfCrumbFetchedAt = 0;

const getYFCrumb = async () => {
  // Reuse crumb for 4 hours
  if (yfCrumb && yfCookie && Date.now() - yfCrumbFetchedAt < 4 * 3600 * 1000) return { crumb: yfCrumb, cookie: yfCookie };
  try {
    // Step 1: get cookie from Yahoo consent page
    const r1 = await axios.get('https://finance.yahoo.com/', {
      headers: YF_HEADERS, timeout: 10000, maxRedirects: 5,
    });
    const setCookie = r1.headers['set-cookie'] || [];
    yfCookie = setCookie.map(c => c.split(';')[0]).join('; ');

    // Step 2: fetch crumb
    const r2 = await axios.get('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { ...YF_HEADERS, 'Cookie': yfCookie }, timeout: 8000,
    });
    yfCrumb = r2.data;
    yfCrumbFetchedAt = Date.now();
    console.log('Yahoo crumb fetched:', yfCrumb?.slice(0,8));
    return { crumb: yfCrumb, cookie: yfCookie };
  } catch (e) {
    console.error('Yahoo crumb fetch failed:', e.message);
    return { crumb: null, cookie: null };
  }
};

const yfGet = async (url, params = {}) => {
  const { crumb, cookie } = await getYFCrumb();
  const headers = { ...YF_HEADERS };
  if (cookie) headers['Cookie'] = cookie;
  if (crumb) params.crumb = crumb;
  const r = await axios.get(url, { params, headers, timeout: 12000 });
  return r.data;
};

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
  const nowIST       = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const midnightIST  = new Date(nowIST);
  midnightIST.setUTCHours(18, 30, 0, 0);
  if (midnightIST <= nowIST) midnightIST.setUTCDate(midnightIST.getUTCDate() + 1);
  const expiresAt = midnightIST.getTime();
  upstoxToken = { access_token: token, expires_at: expiresAt };
  console.log('Upstox token set, expires at:', midnightIST.toISOString());
  saveTokenToSupabase(token, expiresAt); // persist so Render restarts don't lose it
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
        const data = await yfGet(url);
        const meta = data?.chart?.result?.[0]?.meta;
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
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval||'5m'}&range=${range||'1d'}&includePrePost=false`;
    const data = await yfGet(url);
    res.json(data);
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
    const symList = symbols.split(',').slice(0, 15).map(s => s.trim());
    // Use v8/chart (works when v7/quote is blocked)
    const results = await Promise.all(symList.map(fetchOneQuote));
    const valid = results.filter(Boolean);
    res.json({ quoteResponse: { result: valid, error: null } });
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

// ── SCREENER CACHE + SMART SCREENER ──────────────────────
let screenerCache = { data: null, fetchedAt: 0 };

// v8/chart works when v7/quote is blocked — fetch one symbol at a time
const fetchOneQuote = async (sym) => {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d&includePrePost=false`;
    const data = await yfGet(url);
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || !meta.regularMarketPrice) return null;
    const prev = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPrice;
    const curr = meta.regularMarketPrice;
    const vol  = meta.regularMarketVolume || 0;
    // averageDailyVolume10Day from meta if available
    const avg10d = meta.averageDailyVolume10Day || meta.averageDailyVolume3Month || 0;
    return {
      symbol                    : sym,
      regularMarketPrice        : curr,
      regularMarketVolume       : vol,
      averageDailyVolume10Day   : avg10d,
      regularMarketChangePercent: prev ? ((curr - prev) / prev) * 100 : 0,
      regularMarketChange       : curr - prev,
    };
  } catch (_) { return null; }
};

app.get('/api/screener', async (req, res) => {
  const age = Date.now() - screenerCache.fetchedAt;
  if (screenerCache.data && age < 120000)
    return res.json({ quotes: screenerCache.data, cached: true });

  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols required' });

  try {
    const symList = symbols.split(',').filter(Boolean);

    // Fetch with concurrency limit of 10 parallel requests
    const CONCURRENCY = 10;
    const results = [];
    for (let i = 0; i < symList.length; i += CONCURRENCY) {
      const batch = symList.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(fetchOneQuote));
      results.push(...batchResults.filter(Boolean));
      // Small delay to avoid rate limiting
      if (i + CONCURRENCY < symList.length) await new Promise(r => setTimeout(r, 150));
    }

    const flat = results.filter(q => q.regularMarketPrice > 0);
    if (flat.length > 0) screenerCache = { data: flat, fetchedAt: Date.now() };
    if (flat.length === 0 && screenerCache.data)
      return res.json({ quotes: screenerCache.data, cached: true, stale: true });
    if (flat.length === 0)
      return res.status(500).json({ error: 'Yahoo Finance returned 0 results — may be rate limiting. Wait 60s and retry.' });
    res.json({ quotes: flat, cached: false });
  } catch (err) {
    if (screenerCache.data) return res.json({ quotes: screenerCache.data, cached: true, stale: true });
    res.status(500).json({ error: err.message });
  }
});

// ── AI STOCK PICKER ───────────────────────────────────────
app.post('/api/aipick', async (req, res) => {
  const { candidates, mode, capital, leverage } = req.body;
  if (!candidates?.length) return res.status(400).json({ error: 'candidates required' });
  try {
    const top = candidates.slice(0, 20);
    const bp = (capital || 25000) * (leverage || 5);
    const prompt = `NSE intraday screener today. Mode: ${mode}. Buying power: ₹${Math.round(bp).toLocaleString('en-IN')}.

Top stocks by volume surge:
${top.map((c, i) => `${i+1}. ${c.symbol.replace('.NS','')} | ₹${c.price} | Vol ${c.volShock}× | ${c.changePct>0?'+':''}${parseFloat(c.changePct).toFixed(2)}% | ${c.sector}`).join('\n')}

Pick 1-3 best for ${mode} intraday. Rules: BUY = positive momentum + volume surge. SHORT = negative + surge. SL = 1-1.5% from entry. Target = 2× SL (1:2 R:R).

Reply ONLY valid JSON, no other text:
[{"symbol":"RELIANCE","action":"BUY","entry":2850.5,"sl":2821.5,"target":2908.5,"reason":"Volume 3.2× avg, strong uptrend"}]`;
    const { text: rawText, source: aiSrc } = await callAI(prompt, 500);
    const picks = JSON.parse(rawText.replace(/```json|```/g,'').trim());
    res.json({ picks, mode, aiSource: aiSrc });
  } catch (err) {
    console.error('AI pick failed:', err.message);
    const isCredit = err.message?.includes('credit') || err.status === 400;
    res.status(isCredit?402:500).json({ error: isCredit ? 'credit_exhausted' : err.message });
  }
});

// ── AI CHART ANALYSIS ────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { symbol, price, vwap, rsi, atr, action, candles } = req.body;
  if (!price || !vwap) return res.status(400).json({ error: 'price and vwap required' });
  try {
    const vwapDev  = (((price - vwap) / vwap) * 100).toFixed(2);
    const position = price > vwap ? 'above' : 'below';
    const candleSummary = (candles || []).map(c =>
      `[O:${c.o?.toFixed(1)} H:${c.h?.toFixed(1)} L:${c.l?.toFixed(1)} C:${c.c?.toFixed(1)} V:${c.v?.toLocaleString('en-IN')}]`
    ).join(', ');
    const analyzePrompt = `NSE intraday setup for ${symbol}:
Price ₹${price} | VWAP ₹${vwap} (${vwapDev}% ${position}) | RSI ${rsi} | ATR ₹${atr}
Last 5 candles: ${candleSummary}
Proposed: ${action}
Rate this setup. Reply in EXACTLY this format:
QUALITY: HIGH or QUALITY: MEDIUM or QUALITY: LOW | [one sentence — key strength or concern]`;
    const { text } = await callAI(analyzePrompt, 120);
    const quality = text.includes('HIGH') ? 'HIGH' : text.includes('LOW') ? 'LOW' : 'MEDIUM';
    const detail  = text.replace(/^QUALITY:\s*(HIGH|MEDIUM|LOW)\s*\|?\s*/i, '').trim();
    res.json({ quality, detail, raw: text });
  } catch (err) {
    console.error('AI analyze failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── AI NEWS FILTER ────────────────────────────────────────
app.get('/api/news', async (req, res) => {
  const { stock, symbol } = req.query;
  if (!stock) return res.status(400).json({ error: 'stock param required' });
  try {
    const newsPrompt = `Search for news about ${stock} (${symbol}.NS) NSE India stock today ${new Date().toLocaleDateString('en-IN')}. Is there any major event (quarterly results, earnings, regulatory action, management change, FPO, acquisition) that would make intraday technical analysis unreliable today? Reply with ONLY: CLEAR or CAUTION: [one short reason]`;
    // Use Claude with web_search tool, fall back to Grok plain text
    let text = '';
    try {
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5', max_tokens: 120,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: newsPrompt }],
      });
      text = msg.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
    } catch (e) {
      if ((e.status === 400 || e.message?.includes('credit')) && grokEnabled) {
        const r = await callGrok(newsPrompt, 120);
        text = r;
      } else throw e;
    }
    const isClear = text.toUpperCase().includes('CLEAR') && !text.toUpperCase().includes('CAUTION');
    res.json({ status: isClear ? 'CLEAR' : 'CAUTION', detail: text.replace(/^CLEAR\s*/i,'').replace(/^CAUTION:\s*/i,'').trim()||text });
  } catch (err) {
    console.error('News check failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
//  BACKTEST ENGINE — 30-day historical simulation
//  Replays the exact 4-check algorithm on 5-min candles
// ══════════════════════════════════════════════════════════

// ── helpers ───────────────────────────────────────────────
function calcVWAP(candles) {
  let tpv = 0, vol = 0;
  return candles.map(c => {
    const tp = (c.h + c.l + c.c) / 3;
    tpv += tp * c.v; vol += c.v;
    return vol > 0 ? tpv / vol : tp;
  });
}

function calcRSIArr(closes, period = 14) {
  if (closes.length < period + 1) return closes.map(() => null);
  const out = new Array(period).fill(null);
  let gS = 0, lS = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gS += d; else lS -= d;
  }
  let ag = gS / period, al = lS / period;
  out.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return out;
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = candles.slice(1).map((c, i) => {
    const p = candles[i];
    return Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  });
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

// Exact replicas of the engine check functions
function runVWAP(price, vwap, rsi, action) {
  const d = ((price - vwap) / vwap) * 100;
  if (action === 'BUY') {
    if (d > 0 && d <= 0.5) return { pass: true, tv: false };
    if (d <= -1.5 && rsi < 28) return { pass: true, tv: true };
    return { pass: false };
  } else {
    if (d < 0 && Math.abs(d) <= 0.5) return { pass: true, tv: false };
    if (d >= 1.5 && rsi > 72) return { pass: true, tv: true };
    return { pass: false };
  }
}

function runRSI(rsi, action, vtype) {
  if (action === 'BUY') {
    if (vtype === 'tv') return rsi < 28;
    return (rsi >= 45 && rsi <= 65) || rsi < 28;
  } else {
    if (vtype === 'tv') return rsi > 72;
    return (rsi >= 35 && rsi <= 55) || rsi > 72;
  }
}

function runVol(cv, av) { return cv > av * 1.1; }

function runTime(istMins) {
  return (istMins >= 560 && istMins <= 630) || (istMins >= 780 && istMins <= 870);
}

// Simulate one trading day on its 5-min candles
// Returns null if no valid setup found, or { result, entry, sl, t1, t2, exitPrice, pnlGross, action, window }
function simulateDay(dayCandles, action) {
  if (dayCandles.length < 16) return null;

  const closes = dayCandles.map(c => c.c);
  const vwaps  = calcVWAP(dayCandles);
  const rsiArr = calcRSIArr(closes);
  const atr    = calcATR(dayCandles);
  if (!atr) return null;

  for (let i = 15; i < dayCandles.length; i++) {
    const c      = dayCandles[i];
    const istMin = c.istMin;
    if (!runTime(istMin)) continue;

    const price  = c.c;
    const vwap   = vwaps[i];
    const rsi    = rsiArr[i];
    if (vwap == null || rsi == null) continue;

    // 3-bar avg volume (candles i-3..i-1)
    const prevThree = dayCandles.slice(i - 3, i);
    const avg3 = prevThree.reduce((s, x) => s + x.v, 0) / 3;
    if (!runVol(c.v, avg3)) continue;

    const vr = runVWAP(price, vwap, rsi, action);
    if (!vr.pass) continue;
    if (!runRSI(rsi, action, vr.tv ? 'tv' : '')) continue;

    // Valid setup found — build plan
    const sl  = action === 'BUY'
      ? parseFloat((price - 1.5 * atr).toFixed(2))
      : parseFloat((price + 1.5 * atr).toFixed(2));
    const risk = Math.abs(price - sl);
    if (risk <= 0) continue;

    const t1 = action === 'BUY'
      ? parseFloat((price + risk).toFixed(2))
      : parseFloat((price - risk).toFixed(2));
    const t2 = vr.tv
      ? parseFloat(vwap.toFixed(2))
      : action === 'BUY'
        ? parseFloat((price + risk * 2).toFixed(2))
        : parseFloat((price - risk * 2).toFixed(2));

    const rr = (Math.abs(t2 - price) / risk);
    if (rr < 2) continue; // R:R must be >= 2

    // Simulate forward — check remaining candles for T1/T2/SL
    const win = action === 'BUY';
    let result = 'TIMEOUT', exitPrice = price;
    let t1Hit = false;

    for (let j = i + 1; j < dayCandles.length; j++) {
      const fc = dayCandles[j];
      if (win) {
        if (fc.l <= sl) { result = 'LOSS'; exitPrice = sl; break; }
        if (fc.h >= t2)  { result = 'WIN';  exitPrice = t2; break; }
        if (fc.h >= t1 && !t1Hit) t1Hit = true;
      } else {
        if (fc.h >= sl)  { result = 'LOSS'; exitPrice = sl; break; }
        if (fc.l <= t2)  { result = 'WIN';  exitPrice = t2; break; }
        if (fc.l <= t1 && !t1Hit) t1Hit = true;
      }
      // Market close — if T1 was hit, treat as partial win (exit at T1)
      if (j === dayCandles.length - 1 && t1Hit) {
        result = 'WIN'; exitPrice = t1;
      }
    }

    if (result === 'TIMEOUT') {
      exitPrice = dayCandles.at(-1).c;
      const timeoutPnl = win ? exitPrice - price : price - exitPrice;
      result = timeoutPnl >= 0 ? 'TIMEOUT_WIN' : 'TIMEOUT_LOSS';
    }

    const pnlGross = win
      ? (exitPrice - price)
      : (price - exitPrice);

    return {
      result, action, entry: price, sl, t1, t2, exitPrice,
      pnlGross: parseFloat(pnlGross.toFixed(2)),
      rr: parseFloat(rr.toFixed(2)),
      setupTime: `${Math.floor(istMin / 60)}:${String(istMin % 60).padStart(2, '0')}`,
      window: (istMin >= 560 && istMin <= 630) ? 'W1' : 'W2',
      vwap: parseFloat(vwap.toFixed(2)), rsi: parseFloat(rsi.toFixed(1)), atr: parseFloat(atr.toFixed(2)),
    };
  }
  return null;
}

app.get('/api/backtest', async (req, res) => {
  const { symbol, days = 30 } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const sym     = symbol.toUpperCase().replace('.NS', '') + '.NS';
  const nDays   = Math.min(parseInt(days) || 30, 60);
  const range   = nDays <= 30 ? '60d' : '60d'; // Yahoo max for 5m is 60d

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=${range}&includePrePost=false`;
    const r   = await axios.get(url, {
      headers: { 'User-Agent': YF_UA, 'Accept': 'application/json' },
      timeout: 20000,
    });

    const result = r.data?.chart?.result?.[0];
    if (!result) return res.status(404).json({ error: 'No data for symbol' });

    const ts = result.timestamp || [];
    const q  = result.indicators.quote[0];

    // Convert to candles with IST minute
    const allCandles = ts.map((t, i) => {
      if (q.open[i] == null || q.close[i] == null) return null;
      const IST_OFF = 330; // minutes
      const utcMin  = Math.floor(t / 60) % 1440;
      const istMin  = (utcMin + IST_OFF) % 1440;
      const dateIST = new Date((t + 330 * 60) * 1000);
      const dayKey  = `${dateIST.getUTCFullYear()}-${String(dateIST.getUTCMonth() + 1).padStart(2,'0')}-${String(dateIST.getUTCDate()).padStart(2,'0')}`;
      return {
        ts: t, istMin, dayKey,
        o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0,
      };
    }).filter(Boolean);

    // Group by day
    const byDay = {};
    allCandles.forEach(c => {
      if (!byDay[c.dayKey]) byDay[c.dayKey] = [];
      byDay[c.dayKey].push(c);
    });

    // Only trading days with enough candles (>=20), sorted, last nDays
    const tradingDays = Object.keys(byDay)
      .filter(d => byDay[d].length >= 20)
      .sort()
      .slice(-nDays);

    if (tradingDays.length === 0) return res.status(404).json({ error: 'No trading days found' });

    const DAILY_FEE = 45;
    const results = [];

    for (const day of tradingDays) {
      const candles = byDay[day];
      // Try BUY first, if no signal try SHORT
      let trade = simulateDay(candles, 'BUY');
      if (!trade) trade = simulateDay(candles, 'SHORT');

      results.push({
        date    : day,
        ...( trade ? trade : { result: 'NO_SIGNAL', action: null } ),
        // Normalise P&L to per-trade basis for display (not qty-adjusted since we don't know capital)
        netPnl  : trade ? parseFloat((trade.pnlGross - DAILY_FEE / 100).toFixed(2)) : 0, // fee scaled to per-share
      });
    }

    // Aggregate stats
    const traded   = results.filter(r => r.result !== 'NO_SIGNAL');
    const wins     = traded.filter(r => r.result === 'WIN' || r.result === 'TIMEOUT_WIN').length;
    const losses   = traded.filter(r => r.result === 'LOSS' || r.result === 'TIMEOUT_LOSS').length;
    const winRate  = traded.length ? Math.round((wins / traded.length) * 100) : 0;
    const avgWin   = wins ? traded.filter(r => r.result === 'WIN' || r.result === 'TIMEOUT_WIN').reduce((s, t) => s + t.pnlGross, 0) / wins : 0;
    const avgLoss  = losses ? traded.filter(r => r.result === 'LOSS' || r.result === 'TIMEOUT_LOSS').reduce((s, t) => s + Math.abs(t.pnlGross), 0) / losses : 0;
    const expectancy = traded.length ? (winRate / 100 * avgWin - (1 - winRate / 100) * avgLoss) : 0;

    res.json({
      symbol: sym.replace('.NS', ''),
      days  : tradingDays.length,
      stats : { trades: traded.length, wins, losses, winRate, avgWin: parseFloat(avgWin.toFixed(2)), avgLoss: parseFloat(avgLoss.toFixed(2)), expectancy: parseFloat(expectancy.toFixed(2)), noSignal: results.length - traded.length },
      results,
    });
  } catch (err) {
    console.error('Backtest failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
//  AI DAILY PREDICTION — web search + technicals
//  Curated 25 high-predictability NSE stocks
// ══════════════════════════════════════════════════════════

// High-predictability stocks: liquid, trending, technically clean
const PREDICT_UNIVERSE = [
  { sym:'RELIANCE.NS',   name:'Reliance Industries', sector:'Oil & Gas' },
  { sym:'HDFCBANK.NS',   name:'HDFC Bank',            sector:'Banking' },
  { sym:'ICICIBANK.NS',  name:'ICICI Bank',           sector:'Banking' },
  { sym:'INFY.NS',       name:'Infosys',              sector:'IT' },
  { sym:'TCS.NS',        name:'TCS',                  sector:'IT' },
  { sym:'SBIN.NS',       name:'SBI',                  sector:'Banking' },
  { sym:'AXISBANK.NS',   name:'Axis Bank',            sector:'Banking' },
  { sym:'KOTAKBANK.NS',  name:'Kotak Mahindra Bank',  sector:'Banking' },
  { sym:'BAJFINANCE.NS', name:'Bajaj Finance',        sector:'Finance' },
  { sym:'TATAMOTORS.NS', name:'Tata Motors',          sector:'Auto' },
  { sym:'WIPRO.NS',      name:'Wipro',                sector:'IT' },
  { sym:'HCLTECH.NS',    name:'HCL Technologies',     sector:'IT' },
  { sym:'MARUTI.NS',     name:'Maruti Suzuki',        sector:'Auto' },
  { sym:'TITAN.NS',      name:'Titan Company',        sector:'Consumer' },
  { sym:'SUNPHARMA.NS',  name:'Sun Pharma',           sector:'Pharma' },
  { sym:'NTPC.NS',       name:'NTPC',                 sector:'Power' },
  { sym:'POWERGRID.NS',  name:'Power Grid',           sector:'Power' },
  { sym:'TATASTEEL.NS',  name:'Tata Steel',           sector:'Metals' },
  { sym:'HINDALCO.NS',   name:'Hindalco',             sector:'Metals' },
  { sym:'ADANIPORTS.NS', name:'Adani Ports',          sector:'Infra' },
  { sym:'LT.NS',         name:'Larsen & Toubro',      sector:'Infra' },
  { sym:'ONGC.NS',       name:'ONGC',                 sector:'Oil & Gas' },
  { sym:'ITC.NS',        name:'ITC',                  sector:'FMCG' },
  { sym:'BAJAJFINSV.NS', name:'Bajaj Finserv',        sector:'Finance' },
  { sym:'TECHM.NS',      name:'Tech Mahindra',        sector:'IT' },
];

app.get('/api/aiprediction', async (req, res) => {
  try {
    // 1. Fetch 5-day daily OHLCV for all prediction stocks in parallel
    const quoteResults = await Promise.allSettled(
      PREDICT_UNIVERSE.map(async ({ sym, name }) => {
        try {
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=10d&includePrePost=false`;
          const r = await axios.get(url, { headers: { 'User-Agent': YF_UA }, timeout: 8000 });
          const result = r.data?.chart?.result?.[0];
          if (!result) return null;
          const meta = result.meta;
          const ts   = result.timestamp || [];
          const q    = result.indicators.quote[0];
          const days = ts.map((t, i) => ({
            date  : new Date(t * 1000).toISOString().split('T')[0],
            open  : parseFloat((q.open[i]  || 0).toFixed(2)),
            high  : parseFloat((q.high[i]  || 0).toFixed(2)),
            low   : parseFloat((q.low[i]   || 0).toFixed(2)),
            close : parseFloat((q.close[i] || 0).toFixed(2)),
            volume: q.volume[i] || 0,
          })).filter(d => d.close > 0);
          const last   = days.at(-1);
          const prev   = days.at(-2);
          if (!last || !prev) return null;
          const changePct = prev.close ? ((last.close - prev.close) / prev.close * 100) : 0;
          // Simple technical indicators on daily data
          const closes = days.map(d => d.close);
          // EMA20
          let ema20 = closes[0];
          for (let i = 1; i < closes.length; i++) ema20 = closes[i] * (2/21) + ema20 * (19/21);
          // 5-day avg volume
          const avgVol5 = days.slice(-5).reduce((s, d) => s + d.volume, 0) / 5;
          const volShock = avgVol5 ? parseFloat((last.volume / avgVol5).toFixed(2)) : 1;
          // Simple range position (where is close in high-low range over 5 days)
          const h5 = Math.max(...days.slice(-5).map(d => d.high));
          const l5 = Math.min(...days.slice(-5).map(d => d.low));
          const rangePos = h5 > l5 ? parseFloat(((last.close - l5) / (h5 - l5) * 100).toFixed(1)) : 50;
          return {
            sym: sym.replace('.NS', ''), name,
            price: last.close, changePct: parseFloat(changePct.toFixed(2)),
            ema20: parseFloat(ema20.toFixed(2)),
            aboveEma: last.close > ema20,
            volShock, rangePos,
            high5: h5, low5: l5,
            days: days.slice(-5), // last 5 daily candles
          };
        } catch { return null; }
      })
    );

    const stocks = quoteResults
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    if (!stocks.length) return res.status(500).json({ error: 'Failed to fetch stock data' });

    // 2. Use Claude with web_search to analyse each stock and predict today
    const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    const stockSummary = stocks.map(s =>
      `${s.sym} (${s.sector}) | ₹${s.price} | ${s.changePct > 0 ? '+' : ''}${s.changePct}% yesterday | ` +
      `EMA20 ₹${s.ema20} (${s.aboveEma ? 'above' : 'below'}) | Vol ${s.volShock}× | ` +
      `5d range position: ${s.rangePos}% | 5d H:${s.high5} L:${s.low5}`
    ).join('\n');

    const prompt = `Today is ${today}. You are an NSE intraday analyst. Analyse these 25 liquid NSE stocks for today's intraday session.

STOCK DATA (yesterday's close + 5-day technicals):
${stockSummary}

For each stock, search the web for:
1. Any major news today (results, FII buying/selling, sector news, global cues)
2. Technical pattern (breakout/breakdown, trend strength, key level proximity)

Then give your TOP 5-8 stocks with highest intraday potential today.

Reply ONLY with valid JSON array — no other text, no markdown:
[
  {
    "symbol": "RELIANCE",
    "action": "BUY",
    "confidence": "HIGH",
    "price": 2850.5,
    "reason": "2-sentence technical + news reason",
    "pattern": "Breakout above 5d high",
    "sector": "Oil & Gas",
    "risk": "Watch for reversal at 2880"
  }
]
action must be BUY, SHORT, or LEAVE. confidence must be HIGH, MEDIUM, or LOW. Pick 5-8 stocks only.`;

    // Try Claude with web_search, fall back to Grok without web_search
    let text = '';
    let aiSource = 'claude';
    try {
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5', max_tokens: 2000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }],
      });
      text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
    } catch (e) {
      const isCredit = e.status === 400 || e.message?.includes('credit');
      if (isCredit && grokEnabled) {
        console.log('Claude credits exhausted — using Grok for prediction');
        text = await callGrok(prompt, 2000);
        aiSource = 'grok';
      } else throw e;
    }

    let predictions = [];
    try {
      const match = text.match(/\[[\s\S]*\]/);
      predictions = match ? JSON.parse(match[0]) : [];
    } catch { predictions = []; }

    predictions = predictions.map(p => {
      const stock = stocks.find(s => s.sym === p.symbol);
      return { ...p, technicals: stock ? { ema20: stock.ema20, aboveEma: stock.aboveEma, volShock: stock.volShock, rangePos: stock.rangePos, high5: stock.high5, low5: stock.low5 } : null };
    });

    res.json({ predictions, stockCount: stocks.length, generatedAt: new Date().toISOString(), aiSource });
  } catch (err) {
    console.error('AI prediction failed:', err.message);
    const isCredit = err.message?.includes('credit') || err.status === 400;
    res.status(isCredit?402:500).json({ error: isCredit ? 'credit_exhausted' : err.message });
  }
});

// ── HEALTH ────────────────────────────────────────────────
// ── FEEDBACK ──────────────────────────────────────────────
app.post('/api/feedback', async (req, res) => {
  try {
    const { text, user: userEmail='anon', ts=new Date().toISOString() } = req.body || {};
    if (!text?.trim()) return res.status(400).json({ error: 'No feedback text' });

    // Load existing
    let existing = [];
    try {
      const r = await axios.get(`${SB_URL}/rest/v1/settings?key=eq.feedback`, { headers:SB_HEADERS });
      existing = JSON.parse(r.data?.[0]?.value || '[]');
    } catch(_) {}

    existing.push({ text:text.trim(), user:userEmail, ts });
    const trimmed = existing.slice(-200);

    await axios.post(`${SB_URL}/rest/v1/settings`,
      { key:'feedback', value:JSON.stringify(trimmed) },
      { headers:{ ...SB_HEADERS, 'Prefer':'resolution=merge-duplicates' } }
    );
    res.json({ ok:true });
  } catch(err) {
    console.error('Feedback save failed:', err.message);
    res.status(500).json({ error:err.message });
  }
});

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

app.listen(PORT, async () => {
  console.log(`Trade Engine Proxy running on port ${PORT}`);
  // Try to restore Upstox token from Supabase on startup
  const saved = await loadTokenFromSupabase();
  if (saved) {
    upstoxToken = { access_token: saved.token, expires_at: saved.expiresAt };
    console.log('Upstox token restored from Supabase ✓');
  } else {
    console.log('No valid Upstox token — visit /auth/upstox to connect');
  }

  // ── SELF-PING keep-alive (prevents Render free tier from sleeping) ──
  // Pings own /health every 10 minutes
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try {
      const r = await axios.get(`${SELF_URL}/health`, { timeout: 8000 });
      console.log(`Keep-alive ping ✓ ${new Date().toLocaleTimeString()}`);
    } catch(e) {
      console.log(`Keep-alive ping failed: ${e.message}`);
    }
  }, 10 * 60 * 1000); // every 10 minutes
});
