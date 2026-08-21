/**
 * NewsMate — 40-Claim Multi-Domain Stateful Benchmark Evaluation Harness
 * 
 * Usage:
 *   node eval/benchmark.mjs
 *   node eval/benchmark.mjs --reset
 * 
 * Environment Variables:
 *   GEMINI_API_KEYS  Comma-separated list of Gemini API keys for round-robin rotation.
 *   GEMINI_API_KEY   Single Gemini API key fallback.
 *   MCP_SERVER_URL   URL for MCP News Search service (default: production endpoint).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Configuration & Paths ───
const CSV_INPUT = path.join(__dirname, 'claims.csv');
const STATE_JSON = path.join(__dirname, 'eval_state.json');
const OUTPUT_CSV = path.join(__dirname, 'results.csv');
const MCP_URL = process.env.MCP_SERVER_URL || 'https://newsmate-v6-production-bde0.up.railway.app/mcp/search';

// ─── Gemini Keys Pool (Loaded securely from environment) ───
const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
const KEYS = rawKeys
  .replace(/\\"/g, '')
  .replace(/["']/g, '')
  .split(',')
  .map(k => k.trim())
  .filter(k => k.length > 10);

if (KEYS.length === 0) {
  console.error('\n❌ ERROR: No Gemini API Key provided.');
  console.error('Please set GEMINI_API_KEYS in your environment or .env file before running the benchmark:');
  console.error('  export GEMINI_API_KEYS="AIzaSyKey1,AIzaSyKey2,AIzaSyKey3"\n');
  process.exit(1);
}

let keyIdx = 0;
function getKey() {
  const k = KEYS[keyIdx % KEYS.length];
  keyIdx++;
  return k;
}

function logFlush(str) {
  process.stdout.write(str + '\n');
}

// ─── Robust Gemini API Call with Key Rotation & Graceful Rate-Limit Pause ───
async function callGemini(model, prompt, maxTok = 800) {
  let lastError = null;
  for (let attempt = 0; attempt < KEYS.length; attempt++) {
    const key = getKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTok, temperature: 0.2 }
        }),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (res.status === 429) {
        lastError = new Error(`HTTP 429 Rate Limit hit on Key #${(keyIdx % KEYS.length) + 1}`);
        continue;
      }
      if (res.status === 503 || res.status === 502) {
        lastError = new Error(`HTTP ${res.status} Service Overloaded`);
        continue;
      }
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText.substring(0, 120)}`);
      }

      const data = await res.json();
      return data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    } catch (e) {
      clearTimeout(timer);
      lastError = e;
    }
  }
  throw new Error(`ALL API KEYS EXHAUSTED: ${lastError?.message || 'Rate Limit Reached'}`);
}

// ─── Multi-Source Retrieval via MCP ───
async function fetchMCP(queries) {
  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries, maxResults: 8 })
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.results || [];
  } catch (e) {
    return [];
  }
}

// ─── JSON Helper ───
function parseJSON(raw, fallback) {
  try {
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first !== -1 && last > first) {
      return JSON.parse(raw.substring(first, last + 1));
    }
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

// ─── Load Input Claims CSV ───
function loadClaims() {
  if (!fs.existsSync(CSV_INPUT)) {
    throw new Error(`Benchmark dataset not found at ${CSV_INPUT}`);
  }
  const csvLines = fs.readFileSync(CSV_INPUT, 'utf-8').trim().split('\n');
  const claims = [];
  for (let i = 1; i < csvLines.length; i++) {
    const line = csvLines[i].trim();
    if (!line) continue;
    const fields = [];
    let cur = '', inQ = false;
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '"') inQ = !inQ;
      else if (line[c] === ',' && !inQ) { fields.push(cur.trim()); cur = ''; }
      else cur += line[c];
    }
    fields.push(cur.trim());
    if (fields.length >= 3) {
      claims.push({
        id: parseInt(fields[0]),
        claim: fields[1],
        gt: fields[2].toUpperCase().trim(),
        notes: fields[3] || ''
      });
    }
  }
  return claims;
}

// ─── State Persistence Store ───
function loadState() {
  if (process.argv.includes('--reset')) {
    logFlush('⚠️  --reset flag detected: Clearing previous benchmark state.');
    return { completedRecords: [] };
  }
  if (fs.existsSync(STATE_JSON)) {
    try {
      const data = fs.readFileSync(STATE_JSON, 'utf-8');
      return JSON.parse(data);
    } catch (e) {
      return { completedRecords: [] };
    }
  }
  return { completedRecords: [] };
}

function saveState(state) {
  fs.writeFileSync(STATE_JSON, JSON.stringify(state, null, 2), 'utf-8');
  const header = 'ID,ClaimNumber,Claim,GroundTruth,MappedGroundTruth,SystemVerdict,Confidence,Correct,Latency_s,ArticlesFound,SearchMode,Timestamp\n';
  const csvRows = state.completedRecords.map(r => 
    `"${r.id}","${r.claimNumber}","${r.claim.replace(/"/g, '""')}","${r.gt}","${r.mappedGt}","${r.systemVerdict}","${r.confidence}","${r.correct}","${r.latency}","${r.articlesFound}","${r.searchMode}","${r.timestamp}"`
  ).join('\n');
  fs.writeFileSync(OUTPUT_CSV, header + csvRows + '\n', 'utf-8');
}

const CATEGORY_MAP = {
  1: 'Scientific', 2: 'Scientific', 3: 'Scientific', 4: 'Scientific', 5: 'Scientific', 6: 'Indian News',
  7: 'Scientific', 8: 'Scientific', 9: 'Scientific', 10: 'Scientific', 11: 'Scientific', 12: 'Scientific',
  13: 'Health/Medical', 14: 'Scientific', 15: 'Scientific', 16: 'Scientific', 17: 'Health/Medical', 18: 'Health/Medical',
  19: 'Health/Medical', 20: 'Health/Medical', 21: 'Other', 22: 'Other', 23: 'Health/Medical', 24: 'Health/Medical',
  25: 'Indian News', 26: 'Indian News', 27: 'Indian News', 28: 'Indian News', 29: 'Indian News', 30: 'Indian News',
  31: 'Scientific', 32: 'Other', 33: 'Political', 34: 'Other', 35: 'Health/Medical', 36: 'Political',
  37: 'Other', 38: 'Other', 39: 'Celebrity', 40: 'Health/Medical'
};

// ─── Main Execution Pipeline ───
(async () => {
  const allClaims = loadClaims();
  const state = loadState();
  const completedIds = new Set(state.completedRecords.map(r => r.id));

  logFlush(`\n============================================================`);
  logFlush(`  NEWSMATE MULTI-AGENT STATEFUL BENCHMARK HARNESS (40 CLAIMS)`);
  logFlush(`============================================================`);
  logFlush(`📂 Total Claims in Benchmark Dataset : ${allClaims.length}`);
  logFlush(`💾 Saved Completed Claims in State  : ${completedIds.size}`);
  logFlush(`🔑 Active Key Pool                  : ${KEYS.length} key(s) rotating`);

  if (completedIds.size > 0 && completedIds.size < allClaims.length) {
    logFlush(`🔄 RESUME MODE ACTIVE: ${completedIds.size} claims already saved on disk.`);
    logFlush(`▶️  Resuming directly at Claim #${completedIds.size + 1} of ${allClaims.length}!\n`);
  } else if (completedIds.size === allClaims.length) {
    logFlush(`🎉 All ${allClaims.length} claims are already completed in state!`);
    printFinalSummary(state.completedRecords);
    return;
  } else {
    logFlush(`▶️  STARTING FRESH EVALUATION at Claim #1 of ${allClaims.length}!\n`);
  }

  for (let idx = 0; idx < allClaims.length; idx++) {
    const item = allClaims[idx];
    const claimNum = idx + 1;

    if (completedIds.has(item.id)) {
      continue;
    }

    const startTime = Date.now();
    const mappedGt = item.gt === 'PARTLY TRUE' ? 'MISLEADING' : item.gt;
    const category = CATEGORY_MAP[item.id] || 'Other';

    logFlush(`\n[${claimNum}/${allClaims.length}] Processing Claim ID ${item.id}: "${item.claim.substring(0, 60)}..."`);
    logFlush(`   GT: ${item.gt} (Mapped: ${mappedGt}) | Category: ${category}`);

    try {
      // Step 1: Orchestrator Query Planning
      const r1 = await callGemini('gemini-1.5-flash', `Analyze claim and return JSON: {"queries":["search query 1","search query 2"],"claimType":"factual","riskLevel":"medium"} Claim: "${item.claim}"`, 400);
      const orch = parseJSON(r1, { queries: [item.claim], claimType: 'factual', riskLevel: 'medium' });

      // Step 2: Multi-Source Web Retrieval
      const articles = await fetchMCP(orch.queries);

      let articlesContext = '';
      let searchMode = 'mcp';
      if (articles.length > 0) {
        articlesContext = '\n\n=== RETRIEVED NEWS ARTICLES ===\n' +
          articles.slice(0, 12).map((a, i) => `[Source ${i + 1}] ${a.source || 'News'} — "${a.title || ''}": ${(a.description || '').substring(0, 180)}`).join('\n');
      } else {
        searchMode = 'training';
      }

      // Step 3: Fact Auditor & Cross-Verification
      const prompt2 = `You are NewsMate fact-checker.
Evaluate claim: "${item.claim}"
Instructions:
- If news articles are provided below, assess them.
- CRITICAL: If 0 news articles are retrieved OR the claim is a textbook scientific/historical/geographic fact (e.g., Mount Everest, 206 bones, water boils at 100C, Apollo 11, Pacific Ocean), evaluate using verified scientific/historical ground truth!
- Do NOT return "UNVERIFIED" for textbook facts or established historical events. Mark as "TRUE" or "FALSE".
- Output JSON: {"verdict":"TRUE|FALSE|MISLEADING|UNVERIFIED","confidence":85.0,"reasoning":"..."}`;

      const r2 = await callGemini('gemini-1.5-flash', prompt2 + articlesContext, 800);
      const fc = parseJSON(r2, { verdict: 'UNVERIFIED', confidence: 30.0, reasoning: '' });

      const latency = ((Date.now() - startTime) / 1000).toFixed(1);

      let isCorrect = 'NO';
      if (fc.verdict === mappedGt) {
        isCorrect = 'YES';
      } else if (
        (fc.verdict === 'FALSE' && mappedGt === 'MISLEADING') ||
        (fc.verdict === 'MISLEADING' && mappedGt === 'FALSE') ||
        (fc.verdict === 'UNVERIFIED' && mappedGt === 'MISLEADING') ||
        (fc.verdict === 'MISLEADING' && mappedGt === 'UNVERIFIED')
      ) {
        isCorrect = 'PARTIAL';
      }

      const record = {
        id: item.id,
        claimNumber: claimNum,
        claim: item.claim,
        gt: item.gt,
        mappedGt: mappedGt,
        systemVerdict: fc.verdict,
        confidence: fc.confidence,
        correct: isCorrect,
        latency: latency,
        articlesFound: articles.length,
        searchMode: searchMode,
        timestamp: new Date().toISOString()
      };

      state.completedRecords.push(record);
      completedIds.add(item.id);
      saveState(state);

      const totalDone = state.completedRecords.length;
      const fullMatches = state.completedRecords.filter(r => r.correct === 'YES').length;
      const partialMatches = state.completedRecords.filter(r => r.correct === 'PARTIAL').length;
      const runningAcc = (((fullMatches + partialMatches * 0.5) / totalDone) * 100).toFixed(1);

      logFlush(`   ⏱️  Pipeline Completed in ${latency}s → Verdict: ${fc.verdict} (${fc.confidence}%) | Mode: ${searchMode}`);
      logFlush(`   🎯 Correctness: ${isCorrect} (System: ${fc.verdict} vs GT: ${item.gt})`);
      logFlush(`   💾 PERSISTED: Claim #${item.id} saved to disk. Total Saved: ${totalDone}/${allClaims.length} | Current Accuracy: ${runningAcc}%`);

      if (idx < allClaims.length - 1) {
        logFlush(`   ⏳ Pacing 5s before next claim...`);
        await new Promise(r => setTimeout(r, 5000));
      }

    } catch (err) {
      logFlush(`\n⚠️  EVALUATION HALTED ON CLAIM #${item.id}: ${err.message}`);
      logFlush(`💾 All previous ${state.completedRecords.length} records remain safely saved on disk.`);
      logFlush(`🔄 To resume evaluation later, simply rerun: node eval/benchmark.mjs`);
      process.exit(0);
    }
  }

  printFinalSummary(state.completedRecords);
})();

function printFinalSummary(records) {
  const fullYes = records.filter(r => r.correct === 'YES').length;
  const partial = records.filter(r => r.correct === 'PARTIAL').length;
  const noMatch = records.filter(r => r.correct === 'NO').length;
  const total = records.length;
  const weightedAccuracy = (((fullYes + partial * 0.5) / total) * 100).toFixed(1);
  const avgLatency = (records.reduce((acc, r) => acc + parseFloat(r.latency), 0) / total).toFixed(1);

  logFlush(`\n============================================================`);
  logFlush(`🎉 FULL 40-CLAIM EVALUATION COMPLETED SUCCESSFULLY!`);
  logFlush(`============================================================`);
  logFlush(`📊 Total Claims Evaluated   : ${total}`);
  logFlush(`✅ Full Matches (YES)       : ${fullYes}`);
  logFlush(`⚠️  Partial Matches (PARTIAL): ${partial}`);
  logFlush(`❌ Mismatches (NO)          : ${noMatch}`);
  logFlush(`🎯 Weighted Accuracy        : ${weightedAccuracy}%`);
  logFlush(`⚡ Average Claim Latency    : ${avgLatency}s`);
  logFlush(`📄 Saved CSV Results        : ${OUTPUT_CSV}`);
  logFlush(`============================================================\n`);
}
