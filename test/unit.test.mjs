import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

// ─── Re-implement / export core functions for testing ───
function isAuth(url, domains) {
  return !!(url && domains.some(d => url.includes(d)));
}

function calcMathConfidence(sources, verdict, riskLevel, llmConf) {
  const K = sources.length;
  if (K === 0) {
    if (verdict === 'UNVERIFIED') return 21.4;
    return Math.min(84.5, Math.max(12.3, llmConf || 34.2));
  }
  let TP = 0, FP = 0, TN = 0, FN = 0, weightedSum = 0;
  const authDomains = ['bbc.com','reuters.com','cnn.com','indiatoday.in','theguardian.com','apnews.com','thehindu.com','ndtv.com','aljazeera.com','bloomberg.com'];

  sources.forEach(s => {
    const sName = (s.sourceName || s.source || '').toLowerCase();
    const isA = authDomains.some(d => sName.includes(d.split('.')[0])) || s.credibilityNotes?.toLowerCase().includes('authorized');
    const w = isA ? 1.0 : 0.65;

    if (verdict === 'TRUE') {
      if (s.alignment === 'supports') TP += w;
      else if (s.alignment === 'contradicts') FP += w;
    } else if (verdict === 'FALSE') {
      if (s.alignment === 'contradicts') TN += w;
      else if (s.alignment === 'supports') FN += w;
    } else {
      if (s.alignment === 'supports') TP += 0.5 * w;
      else if (s.alignment === 'contradicts') TN += 0.5 * w;
    }
    weightedSum += w;
  });

  const total = TP + FP + TN + FN + 0.0001;
  const S_consensus = (TP + TN) / total;

  const riskPenalty = riskLevel === 'high' ? 0.15 : riskLevel === 'medium' ? 0.08 : 0.03;
  const neutralCount = sources.filter(s => s.alignment === 'neutral').length;
  const entropyPenalty = (neutralCount / (K || 1)) * 0.12;
  const Omega = Math.max(0.45, 1.0 - riskPenalty - entropyPenalty);

  let rawScore = (0.65 * S_consensus + 0.35 * (weightedSum / K)) * Omega * 100;
  if (typeof llmConf === 'number' && llmConf > 0) {
    rawScore = 0.65 * rawScore + 0.35 * llmConf;
  }
  if (verdict === 'UNVERIFIED') {
    rawScore = Math.min(48.5, Math.max(7.2, rawScore * 0.55));
  }
  return parseFloat(Math.min(98.8, Math.max(5.1, rawScore)).toFixed(1));
}

function calcBrierScore(evalRecords) {
  if (!evalRecords || evalRecords.length === 0) return 0;
  let sumSq = 0;
  evalRecords.forEach(r => {
    const p = (r.confidence || 50) / 100;
    const o = r.verdict === r.groundTruth ? 1 : 0;
    sumSq += Math.pow(p - o, 2);
  });
  return parseFloat((sumSq / evalRecords.length).toFixed(4));
}

// ─── UNIT TESTS ───
describe('NewsMate Core Logic Unit Tests', () => {
  test('isAuth should correctly identify whitelisted news domains', () => {
    const domains = ['bbc.com', 'reuters.com', 'cnn.com'];
    assert.equal(isAuth('https://www.bbc.com/news/123', domains), true);
    assert.equal(isAuth('https://reuters.com/world', domains), true);
    assert.equal(isAuth('https://randomblog.xyz/post', domains), false);
  });

  test('calcMathConfidence should return high confidence for TRUE claims supported by authorized sources', () => {
    const sources = [
      { sourceName: 'BBC', alignment: 'supports', credibilityNotes: 'Authorized' },
      { sourceName: 'Reuters', alignment: 'supports', credibilityNotes: 'Authorized' }
    ];
    const score = calcMathConfidence(sources, 'TRUE', 'medium', 90);
    assert.ok(score > 70, `Score ${score} should be > 70`);
    assert.ok(score <= 98.8, `Score ${score} should be <= 98.8`);
  });

  test('calcMathConfidence should penalize UNVERIFIED verdicts with lower dynamic scores', () => {
    const sources = [
      { sourceName: 'Blog', alignment: 'neutral', credibilityNotes: 'Unverified' }
    ];
    const score = calcMathConfidence(sources, 'UNVERIFIED', 'high', 40);
    assert.ok(score < 50, `Score ${score} should be < 50 for UNVERIFIED`);
  });

  test('calcBrierScore should compute accurate probability error scalar', () => {
    const records = [
      { confidence: 90, verdict: 'TRUE', groundTruth: 'TRUE' }, // p=0.9, o=1 -> (0.1)^2 = 0.01
      { confidence: 80, verdict: 'FALSE', groundTruth: 'TRUE' } // p=0.8, o=0 -> (0.8)^2 = 0.64
    ];
    // mean sq err = (0.01 + 0.64)/2 = 0.325
    const bs = calcBrierScore(records);
    assert.equal(bs, 0.325);
  });
});
