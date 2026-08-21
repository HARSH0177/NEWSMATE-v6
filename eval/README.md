# 📊 NewsMate Benchmark Evaluation Suite

This directory contains the **40-Claim Multi-Domain Stateful Evaluation Harness** for benchmarking fact-checking accuracy, multi-source retrieval reliability, latency, and rate-limit resilience.

---

## 🎯 Evaluation Dataset Structure (`eval/claims.csv`)

The benchmark consists of 40 hand-curated claims across diverse categories to evaluate hallucination prevention, textbook grounding, live news retrieval, and ambiguity handling:

| Domain | Claim Count | Example Claim | Target Ground Truth |
| :--- | :---: | :--- | :---: |
| **Scientific Facts** | 12 | *"Water boils at 100 degrees Celsius at standard sea-level pressure"* | `TRUE` |
| **Debunked Myths** | 8 | *"Humans only use 10% of their brains"* | `FALSE` |
| **Medical / Health Claims** | 8 | *"Antibiotics are an effective treatment for the common cold"* | `MISLEADING` |
| **Indian EV / Tech News (2025–2026)** | 6 | *"India's EV sales in 2025 reached ~2.3M units"* | `TRUE` / `PARTLY TRUE` |
| **Unverified Breaking Rumors** | 6 | *"Major undisclosed data breach affecting leading fintech..."* | `UNVERIFIED` |

---

## 🚀 Running the Evaluation Benchmark

### 1. Set Your Gemini API Key(s)
You can provide a single key or a comma-separated list of keys for automatic round-robin rotation:

```bash
# Single key
export GEMINI_API_KEYS="AIzaSyYourKeyHere..."

# Multi-key rotation (recommended for continuous zero-rate-limit runs)
export GEMINI_API_KEYS="AIzaSyKey1...,AIzaSyKey2...,AIzaSyKey3..."
```

### 2. Execute the Harness
```bash
# Run benchmark (auto-resumes from last saved checkpoint if interrupted)
npm run eval

# Or run directly via Node.js
node eval/benchmark.mjs

# Reset and restart from Claim #1
node eval/benchmark.mjs --reset
```

---

## 📈 Scoring Methodology

- **Exact Match (`YES`, 1.0 pt)**: `System Verdict === Ground Truth` (e.g. `TRUE` vs `TRUE`, `FALSE` vs `FALSE`, `UNVERIFIED` vs `UNVERIFIED`).
- **Partial Match (`PARTIAL`, 0.5 pt)**: Nuanced semantic alignment (e.g. `FALSE` on a `MISLEADING` myth, or `UNVERIFIED` on a disputed/emerging claim).
- **Mismatch (`NO`, 0.0 pt)**: Opposite classification (e.g. `TRUE` on a `FALSE` claim).

$$\text{Weighted Accuracy} = \frac{N_{\text{YES}} + 0.5 \times N_{\text{PARTIAL}}}{N_{\text{Total}}} \times 100\%$$

---

## 💾 State Persistence & Zero Rate-Limit Crash Guarantee

1. **Incremental Persistence**: Every claim verdict, confidence score, and latency reading is immediately flushed to `eval/eval_state.json` and `eval/results.csv`.
2. **Crash-Safe**: If an API quota is exhausted (HTTP 429), the script halts gracefully without losing previous evaluations. Re-running picks up automatically from the exact next claim.
