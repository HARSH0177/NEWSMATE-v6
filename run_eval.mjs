import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  gk: 'AIzaSyAjEc1RDR57EDPyxF3dbawqsmVizsQiRD4',
  nk: '9550ad0e2cba4aa9b654bf68694cea23',
  gnk: 'bff953d35e1603c9e54aa91dc79dba70',
  mcp: 'https://newsmate-v6-production-bde0.up.railway.app'
};

// ─── Load CSV ───────────────────────────────────────────────
function parseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '"') {
        inQuotes = !inQuotes;
      } else if (line[c] === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += line[c];
      }
    }
    fields.push(current.trim());

    if (fields.length >= 3) {
      records.push({
        id: parseInt(fields[0]),
        claim: fields[1],
        ground_truth_verdict: fields[2],
        notes: fields[3] || ''
      });
    }
  }
  return records;
}

const csvPath = resolve('C:\\Users\\HARSH AMBULE\\Downloads\\newsmate_eval_claims.csv');
const csvText = readFileSync(csvPath, 'utf-8');
const claims = parseCSV(csvText);
console.log(`✅ Loaded ${claims.length} claims from CSV\n`);

// ─── Category Mapping ───────────────────────────────────────
const CATEGORY_MAP = {
  1: 'Scientific',     2: 'Scientific',     3: 'Scientific',
  4: 'Scientific',     5: 'Scientific',     6: 'Indian News',
  7: 'Scientific',     8: 'Scientific',     9: 'Scientific',
  10: 'Scientific',    11: 'Scientific',    12: 'Scientific',
  13: 'Health/Medical', 14: 'Scientific',   15: 'Scientific',
  16: 'Scientific',    17: 'Health/Medical', 18: 'Health/Medical',
  19: 'Health/Medical', 20: 'Health/Medical', 21: 'Other',
  22: 'Other',         23: 'Health/Medical', 24: 'Health/Medical',
  25: 'Indian News',   26: 'Indian News',   27: 'Indian News',
  28: 'Indian News',   29: 'Indian News',   30: 'Indian News',
  31: 'Scientific',    32: 'Other',         33: 'Political',
  34: 'Other',         35: 'Health/Medical', 36: 'Political',
  37: 'Other',         38: 'Other',         39: 'Celebrity',
  40: 'Health/Medical'
};

// ─── Ground Truth → App Label Mapping ───────────────────────
function mapGroundTruth(gt) {
  const mapped = gt.toUpperCase().trim();
  if (mapped === 'PARTLY TRUE') return 'MISLEADING';
  return mapped;
}

// ─── Correctness Assessment ─────────────────────────────────
function assessCorrectness(systemVerdict, groundTruth) {
  const sv = systemVerdict.toUpperCase().replace(/[^A-Z]/g, '');
  const gt = groundTruth.toUpperCase().trim();

  let svClean = sv;
  if (sv.includes('TRUE') && !sv.includes('FALSE')) svClean = 'TRUE';
  else if (sv.includes('FALSE')) svClean = 'FALSE';
  else if (sv.includes('MISLEADING')) svClean = 'MISLEADING';
  else if (sv.includes('UNVERIFIED')) svClean = 'UNVERIFIED';
  else if (sv.includes('SATIRE')) svClean = 'SATIRE';

  if (svClean === gt) return 'yes';
  if (gt === 'PARTLY TRUE') {
    if (svClean === 'MISLEADING') return 'yes';
    if (['TRUE', 'UNVERIFIED'].includes(svClean)) return 'partial';
    return 'no';
  }
  if (svClean === 'MISLEADING' && gt === 'FALSE') return 'partial';
  if (svClean === 'FALSE' && gt === 'MISLEADING') return 'partial';
  if (svClean === 'UNVERIFIED' && gt === 'MISLEADING') return 'partial';
  if (svClean === 'MISLEADING' && gt === 'UNVERIFIED') return 'partial';
  if (svClean === 'UNVERIFIED' && gt === 'FALSE') return 'partial';

  return 'no';
}

// ─── Main Execution ─────────────────────────────────────────
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-web-security', '--disable-site-isolation-trials']
  });

  const page = await browser.newPage();
  const appPath = resolve(__dirname, 'public', 'index.html');
  const appUrl = `file:///${appPath.replace(/\\/g, '/')}`;

  console.log(`🌐 Opening app: ${appUrl}`);
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // Clear previous dataset & inject full configuration
  await page.evaluate((cfg) => {
    localStorage.removeItem('nm:research:v1');
    sessionStorage.setItem('gk', cfg.gk);
    sessionStorage.setItem('nk', cfg.nk);
    sessionStorage.setItem('gnk', cfg.gnk);
    sessionStorage.setItem('mcp', cfg.mcp);
    updateMcpPill();
  }, CONFIG);

  console.log(`🔑 Config injected: MCP Server set to ${CONFIG.mcp}`);
  console.log('⚡ Fast evaluation mode initialized (60s max per claim).\n');

  const results = [];
  const skipped = [];

  console.log('════════════════════════════════════════════════════════════');
  console.log('  STARTING 5-CLAIM MCP INTEGRATION TEST (CLAIMS 1 to 5)');
  console.log('════════════════════════════════════════════════════════════');

  const testClaims = claims.slice(0, 5);

  for (let idx = 0; idx < testClaims.length; idx++) {
    const c = testClaims[idx];
    const claimNum = idx + 1;
    const category = CATEGORY_MAP[c.id] || 'Other';
    const trueLabel = mapGroundTruth(c.ground_truth_verdict);

    console.log(`\n[${claimNum}/40] ID ${c.id}: "${c.claim.substring(0, 70)}..."`);
    console.log(`   GT: ${c.ground_truth_verdict} (Mapped: ${trueLabel}) | Cat: ${category}`);

    try {
      // 1. Enter claim
      await page.fill('textarea#claim', '');
      await page.fill('textarea#claim', c.claim);
      await page.waitForTimeout(200);

      // 2. Click Verify
      await page.click('#vBtn');
      const startTime = Date.now();

      // 3. Wait for result (#res gets 'show' class or error alert) — strict 60s timeout
      try {
        await page.waitForFunction(() => {
          const res = document.getElementById('res');
          const alt = document.getElementById('altBox');
          return (res && res.classList.contains('show')) || (alt && alt.classList.contains('show') && alt.classList.contains('error'));
        }, null, { timeout: 120000 }); // 120 seconds max per claim
      } catch (timeoutErr) {
        console.log(`   ❌ Timeout (120s limit reached)`);
        skipped.push({ id: c.id, claim: c.claim, reason: 'Timeout (60s limit reached)' });
        await page.evaluate(() => resetAll());
        await page.waitForTimeout(3000);
        continue;
      }

      // Check for error alert
      const isError = await page.evaluate(() => {
        const alt = document.getElementById('altBox');
        return alt && alt.classList.contains('show') && alt.classList.contains('error');
      });

      if (isError) {
        const errMsg = await page.textContent('#altMsg');
        console.log(`   ❌ App Error: ${errMsg}`);
        skipped.push({ id: c.id, claim: c.claim, reason: errMsg });
        await page.evaluate(() => resetAll());

        if (errMsg.includes('429') || errMsg.includes('quota')) {
          console.log('   ⏳ 429 Rate limit — waiting 30s before next claim...');
          await page.waitForTimeout(30000);
        } else {
          await page.waitForTimeout(3000);
        }
        continue;
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      // 4. Read verdict & search mode
      const stampText = await page.textContent('#vstamp');
      const cleanVerdict = stampText.replace(/[^\w\s]/g, '').trim();

      const searchModeUsed = await page.evaluate(() => {
        const badge = document.getElementById('srcModeBadge');
        if (badge?.textContent?.includes('MCP')) return 'mcp';
        if (badge?.textContent?.includes('Google Search')) return 'gemini';
        return 'training';
      });

      console.log(`   ⏱️ Pipeline completed in ${duration}s → Verdict: ${cleanVerdict} | Mode: ${searchModeUsed}`);

      // 5. Correctness assessment
      const correctness = assessCorrectness(cleanVerdict, c.ground_truth_verdict);
      console.log(`   🎯 Correctness: ${correctness.toUpperCase()} (System: ${cleanVerdict} vs GT: ${c.ground_truth_verdict})`);

      // 6. Fill Research Logger
      await page.selectOption('#rlogCat', category);
      await page.selectOption('#rlogTrue', trueLabel);
      await page.selectOption('#rlogCorrect', correctness);

      // Notes
      let note = '';
      if (c.ground_truth_verdict === 'PARTLY TRUE') note += 'GT PARTLY TRUE mapped to MISLEADING. ';
      const terminalContent = await page.evaluate(() => document.getElementById('term')?.textContent || '');
      if (terminalContent.includes('MCP error')) note += 'MCP fallback to Gemini Search. ';
      if (terminalContent.includes('429')) note += 'Rate limit 429 backoff inside pipeline. ';
      if (note) await page.fill('#rlogNotes', note.trim());

      // 7. Save to Dataset
      await page.click('.rlog-save');
      await page.waitForTimeout(400);
      console.log(`   💾 Record saved to dataset ("nm:research:v1")`);

      results.push({
        id: c.id,
        claim: c.claim,
        groundTruth: c.ground_truth_verdict,
        sysVerdict: cleanVerdict,
        correctness,
        searchMode: searchModeUsed,
        duration
      });

      // 8. Reset before next claim
      await page.click('.rbtn'); // Verify Another Claim
      await page.waitForTimeout(5000); // 5s throttle between claims

    } catch (err) {
      console.log(`   ❌ Unexpected script error: ${err.message}`);
      skipped.push({ id: c.id, claim: c.claim, reason: err.message });
      try { await page.evaluate(() => resetAll()); } catch {}
      await page.waitForTimeout(3000);
    }
  }

  // ─── Dashboard Metrics & CSV Export ───────────────────────
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  READING RESEARCH DASHBOARD METRICS');
  console.log('════════════════════════════════════════════════════════════\n');

  await page.evaluate(() => openR());
  await page.waitForTimeout(1000);

  const metrics = await page.evaluate(() => {
    return {
      total: document.getElementById('sm-total')?.textContent || '—',
      accuracy: document.getElementById('sm-acc')?.textContent || '—',
      f1: document.getElementById('sm-f1')?.textContent || '—',
      precision: document.getElementById('sm-prec')?.textContent || '—',
      recall: document.getElementById('sm-rec')?.textContent || '—',
      avgLatency: document.getElementById('sm-lat')?.textContent || '—',
      mcpAcc: document.getElementById('sm-mcp-acc')?.textContent || '—',
      geminiAcc: document.getElementById('sm-gem-acc')?.textContent || '—',
    };
  });

  const catTable = await page.evaluate(() => {
    const rows = document.querySelectorAll('#catTable .mtbl tbody tr');
    return Array.from(rows).map(tr => {
      const cells = tr.querySelectorAll('td');
      return {
        category: cells[0]?.textContent?.trim() || '',
        total: cells[1]?.textContent?.trim() || '',
        correct: cells[2]?.textContent?.trim() || '',
        partial: cells[3]?.textContent?.trim() || '',
        accuracy: cells[4]?.textContent?.trim() || '',
      };
    });
  });

  const ablTable = await page.evaluate(() => {
    const rows = document.querySelectorAll('#ablTable .mtbl tbody tr');
    return Array.from(rows).map(tr => {
      const cells = tr.querySelectorAll('td');
      return {
        mode: cells[0]?.textContent?.trim() || '',
        tests: cells[1]?.textContent?.trim() || '',
        correct: cells[2]?.textContent?.trim() || '',
        accuracy: cells[3]?.textContent?.trim() || '',
        avgConfidence: cells[4]?.textContent?.trim() || '',
        avgLatency: cells[5]?.textContent?.trim() || '',
      };
    });
  });

  // Extract CSV directly from localStorage dataset
  const csvOutput = await page.evaluate(() => {
    const RK = 'nm:research:v1';
    const recs = JSON.parse(localStorage.getItem(RK) || '[]');
    const headers = ['ID','Timestamp','Claim','Category','TrueLabel','SystemVerdict','Confidence_pct','Correct','SearchMode','Latency_ms','ArticlesFound','Notes'];
    const rows = recs.map(r => [
      r.id, r.ts,
      `"${(r.claim||'').replace(/"/g,'""')}"`,
      r.category, r.trueLabel, r.sysVerdict, r.confidence,
      r.correct, r.searchMode, r.latencyMs||0, r.articlesFound||0,
      `"${(r.notes||'').replace(/"/g,'""')}"`
    ].join(','));
    return [headers.join(','), ...rows].join('\n');
  });

  const exportFileName = `newsmate_eval_results_mcp_${new Date().toISOString().slice(0,10)}.csv`;
  const exportFilePath = resolve(__dirname, exportFileName);
  writeFileSync(exportFilePath, csvOutput, 'utf-8');

  // Print Summary JSON
  console.log('===FINAL_EVAL_JSON_START===');
  console.log(JSON.stringify({
    metrics,
    catTable,
    ablTable,
    resultsCount: results.length,
    skippedCount: skipped.length,
    skippedDetails: skipped,
    exportFilePath
  }, null, 2));
  console.log('===FINAL_EVAL_JSON_END===');

  await browser.close();
})();
