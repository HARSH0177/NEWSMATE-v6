const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { z } = require('zod');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CORS ───────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Accept'], credentials: false, maxAge: 86400 }));
app.use(express.json({ limit: '10mb' })); // larger limit for image uploads

// ─── Serve frontend ─────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── API Keys (Loaded from process.env / Railway Environment Variables) ──────
const NEWS_API_KEY = process.env.NEWS_API_KEY || '9550ad0e2cba4aa9b654bf68694cea23';
const GNEWS_API_KEY = process.env.GNEWS_API_KEY || 'bff953d35e1603c9e54aa91dc79dba70';
const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || 'AIzaSyAjEc1RDR57EDPyxF3dbawqsmVizsQiRD4')
  .replace(/\\"/g, '')
  .replace(/["']/g, '')
  .split(',')
  .map(k => k.trim())
  .filter(k => k.startsWith('AIzaSy'));

if (GEMINI_KEYS.length === 0) {
  GEMINI_KEYS.push('AIzaSyAjEc1RDR57EDPyxF3dbawqsmVizsQiRD4');
}

let currentKeyIndex = 0;

// ─── Source Whitelist (19 Authorized) ───────────────────────────────────────
const SOURCES = {
  'cnn.com': 'CNN', 'bbc.com': 'BBC', 'reuters.com': 'Reuters',
  'indiatoday.in': 'India Today', 'theguardian.com': 'The Guardian',
  'apnews.com': 'AP News', 'aljazeera.com': 'Al Jazeera',
  'thehindu.com': 'The Hindu', 'ndtv.com': 'NDTV',
  'timesofindia.indiatimes.com': 'Times of India', 'npr.org': 'NPR',
  'nytimes.com': 'NY Times', 'washingtonpost.com': 'Washington Post',
  'bloomberg.com': 'Bloomberg', 'economist.com': 'The Economist',
  'forbes.com': 'Forbes', 'ft.com': 'Financial Times',
  'abcnews.go.com': 'ABC News', 'cbsnews.com': 'CBS News'
};
const DOMAINS = Object.keys(SOURCES);
function isAuth(url) { return url && DOMAINS.some(d => url.includes(d)); }
function srcName(url) { const d = DOMAINS.find(d => url && url.includes(d)); return d ? SOURCES[d] : 'Unknown'; }

// ─── HTTP helper ────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'NewsMate/6.0' } }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { reject(new Error('JSON parse failed')); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', e => reject(new Error(e.message)));
  });
}

// ─── HTTP helper for text (DuckDuckGo HTML) ─────────────────────────────────
function httpGetText(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGetText(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', e => reject(new Error(e.message)));
  });
}

// ─── News fetchers ──────────────────────────────────────────────────────────
async function fromNewsAPI(q, max) {
  if (!NEWS_API_KEY || NEWS_API_KEY.includes('YOUR')) return [];
  try {
    const { status, data } = await httpGet(`https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&apiKey=${NEWS_API_KEY}&pageSize=${max}&language=en&sortBy=relevancy`);
    if (status !== 200 || !data.articles) return [];
    return data.articles.map(a => {
      if (!a.url || !a.title) return null;
      const isA = isAuth(a.url);
      const sName = isA ? srcName(a.url) : (a.source?.name || new URL(a.url).hostname.replace('www.',''));
      return {
        title: a.title || '', description: a.description || '', url: a.url,
        source: sName, provider: 'newsapi',
        publishedAt: a.publishedAt || '',
        authorized: isA
      };
    }).filter(Boolean);
  } catch (e) { console.error('[NewsAPI]', e.message); return []; }
}

async function fromGNews(q, max) {
  if (!GNEWS_API_KEY || GNEWS_API_KEY.includes('YOUR')) return [];
  try {
    const { status, data } = await httpGet(`https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&token=${GNEWS_API_KEY}&lang=en&max=${max}`);
    if (status !== 200 || !data.articles) return [];
    return data.articles.map(a => {
      if (!a.url || !a.title) return null;
      const isA = isAuth(a.url);
      const sName = isA ? srcName(a.url) : (a.source?.name || new URL(a.url).hostname.replace('www.',''));
      return {
        title: a.title || '', description: a.description || '', url: a.url,
        source: sName, provider: 'gnews',
        publishedAt: a.publishedAt || '',
        authorized: isA
      };
    }).filter(Boolean);
  } catch (e) { console.error('[GNews]', e.message); return []; }
}

// ─── DuckDuckGo web search (free, no API key) ──────────────────────────────
async function fromDuckDuckGo(q, max) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const html = await httpGetText(url);
    const results = [];
    const blocks = html.split('class="result__body"');
    for (let i = 1; i < blocks.length && results.length < max; i++) {
      const block = blocks[i];
      const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
      const urlMatch = block.match(/class="result__url"[^>]*href="([^"]+)"/);
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([^<]+(?:<[^>]+>[^<]+)*)/);
      const rawUrl = urlMatch ? urlMatch[1].replace(/.*uddg=/, '').split('&')[0] : '';
      const decodedUrl = rawUrl ? decodeURIComponent(rawUrl) : '';
      if (titleMatch && decodedUrl) {
        const isA = isAuth(decodedUrl);
        results.push({
          title: titleMatch[1].trim(),
          description: snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '',
          url: decodedUrl,
          source: isA ? srcName(decodedUrl) : new URL(decodedUrl).hostname.replace('www.',''),
          provider: 'duckduckgo',
          publishedAt: '',
          authorized: isA
        });
      }
    }
    return results;
  } catch (e) { console.error('[DuckDuckGo]', e.message); return []; }
}

async function searchAll(q, max) {
  const [a, b, c] = await Promise.all([fromNewsAPI(q, max), fromGNews(q, max), fromDuckDuckGo(q, Math.min(max, 5))]);
  const seen = new Set(), out = [];
  const combined = [...a, ...b, ...c];
  // Prioritize authorized sources first
  combined.sort((x, y) => (y.authorized ? 1 : 0) - (x.authorized ? 1 : 0));
  for (const x of combined) {
    if (!x.url || seen.has(x.url)) continue;
    seen.add(x.url);
    out.push(x);
  }
  return out;
}

// ─── MCP Server (Model Context Protocol) ───────────────────────────────────
const mcpServer = new McpServer({ name: 'newsmate', version: '6.0.0' });

mcpServer.tool(
  'search_news',
  'Search for news articles from multiple trusted sources (CNN, BBC, Reuters, etc.) plus web search',
  {
    query: z.string().describe('The search query for news articles'),
    maxResults: z.number().optional().default(10).describe('Maximum results per source'),
  },
  async ({ query, maxResults }) => {
    try {
      const results = await searchAll(query, maxResults);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, count: results.length, results: results.slice(0, 20) }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: e.message }) }], isError: true };
    }
  }
);

// ─── SSE Transport ──────────────────────────────────────────────────────────
const transports = {};
app.get('/sse', async (req, res) => {
  console.log('[MCP] SSE client connected');
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;
  res.on('close', () => { delete transports[transport.sessionId]; });
  await mcpServer.connect(transport);
});
app.post('/messages', async (req, res) => {
  const transport = transports[req.query.sessionId];
  if (!transport) return res.status(400).json({ error: 'No active SSE session' });
  await transport.handlePostMessage(req, res);
});

// ─── REST endpoints ─────────────────────────────────────────────────────────
app.use((req, _, next) => { console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`); next(); });

app.get('/health', (_, res) => res.json({
  status: 'ok', version: '6.0.0', cors: true, mcp: true,
  sources: { newsapi: !NEWS_API_KEY.includes('YOUR'), gnews: !GNEWS_API_KEY.includes('YOUR'), duckduckgo: true }
}));

app.get('/trending', async (_, res) => {
  try {
    const { status, data } = await httpGet(`https://gnews.io/api/v4/top-headlines?category=general&lang=en&max=5&token=${GNEWS_API_KEY}`);
    if (status === 200 && data.articles) {
      const titles = data.articles.map(a => a.title.split(' - ')[0]).slice(0, 4);
      return res.json({ success: true, trending: titles });
    }
    // Fallback if GNews fails
    res.json({ success: true, trending: ["Global markets see unexpected shift", "New breakthroughs in AI research", "Extreme weather events on the rise", "Major tech company announces restructuring"] });
  } catch (e) {
    res.json({ success: true, trending: ["Global markets see unexpected shift", "New breakthroughs in AI research", "Extreme weather events on the rise", "Major tech company announces restructuring"] });
  }
});

app.post('/api/gemini', async (req, res) => {
  const { model = 'gemini-1.5-flash', prompt, maxTok = 800, tools = null, responseSchema = null, responseMimeType = null } = req.body || {};
  const customKey = req.headers['x-gemini-key'];
  const keysToTry = customKey ? [customKey] : GEMINI_KEYS;

  const genConfig = { maxOutputTokens: maxTok, temperature: 0.2 };
  if (responseMimeType) genConfig.responseMimeType = responseMimeType;
  if (responseSchema) genConfig.responseSchema = responseSchema;

  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: genConfig };
  if (tools) body.tools = tools;

  for (let attempt = 0; attempt < keysToTry.length; attempt++) {
    const activeIndex = (currentKeyIndex + attempt) % keysToTry.length;
    const key = keysToTry[activeIndex];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

    try {
      const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await resp.json();

      if (resp.status === 429 && keysToTry.length > 1) {
        console.warn(`[Proxy] ⚡ Key #${activeIndex + 1} hit 429. Instantly rotating to Key #${(activeIndex + 1) % keysToTry.length + 1}…`);
        currentKeyIndex = (currentKeyIndex + 1) % keysToTry.length;
        continue;
      }

      return res.status(resp.status).json(data);
    } catch (e) {
      if (attempt === keysToTry.length - 1) {
        return res.status(500).json({ error: { message: e.message } });
      }
    }
  }
});

app.post('/mcp/search', async (req, res) => {
  const { query, queries, maxResults = 10 } = req.body || {};
  if (!query && !(Array.isArray(queries) && queries.length))
    return res.status(400).json({ success: false, error: 'Provide query or queries' });
  const terms = (Array.isArray(queries) && queries.length) ? queries.slice(0, 5) : [query];
  console.log(`[search] Queries:`, terms);
  try {
    const all = [];
    for (const q of terms) all.push(...await searchAll(q, maxResults));
    const seen = new Set(), final = [];
    for (const a of all) { if (!a.url || seen.has(a.url)) continue; seen.add(a.url); final.push(a); }
    console.log(`[search] → ${final.length} articles`);
    res.json({ success: true, count: final.length, results: final.slice(0, 25) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 NewsMate V6 Server running on port ${PORT}`);
  console.log(`   Frontend  : http://localhost:${PORT}`);
  console.log(`   MCP SSE   : http://localhost:${PORT}/sse`);
  console.log(`   Health    : http://localhost:${PORT}/health`);
  console.log(`   NewsAPI   : ${!NEWS_API_KEY.includes('YOUR') ? '✅' : '❌'}`);
  console.log(`   GNews     : ${!GNEWS_API_KEY.includes('YOUR') ? '✅' : '❌'}`);
  console.log(`   DuckDuckGo: ✅ (free, no key needed)\n`);
});
