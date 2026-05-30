#!/usr/bin/env node
/**
 * fetch-swebench.mjs — SPEC-004 / DR-009
 *
 * THE ONLY NETWORK-TOUCHING COMPONENT of the classifier-validation harness.
 *
 * Invariant #2 (tiered network consent, DR-004): this script lives OUTSIDE
 * `packages/minspec` and `packages/scroogellm`, is never imported by extension
 * code, and is run manually by a developer. The extension and its committed tests
 * never perform network I/O.
 *
 * Downloads a curated subset of SWE-bench-Verified (princeton-nlp/SWE-bench_Verified)
 * via the HuggingFace datasets-server API and writes:
 *
 *     scripts/classifier-validation/.data/instances.json
 *
 * as an array of { instanceId, repo, problemStatement, patch }.
 *
 * The .data/ directory is gitignored — patches are never committed (size +
 * upstream licensing). Only the hand-assigned tier labels in labels.json are.
 *
 * Usage:  node scripts/classifier-validation/fetch-swebench.mjs [count]
 *         count defaults to 50 (NFR-2: proportional subset, not all 500).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '.data');
const OUT = join(DATA_DIR, 'instances.json');

const DATASET = 'princeton-nlp/SWE-bench_Verified';
const CONFIG = 'default';
const SPLIT = 'test';
const API = 'https://datasets-server.huggingface.co/rows';
const INFO = 'https://datasets-server.huggingface.co/info';

const PAGE = 100; // datasets-server max length per request

const count = Math.max(1, parseInt(process.argv[2] ?? '50', 10) || 50);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, attempt = 0) {
  const res = await fetch(url);
  if (res.status === 429 && attempt < 5) {
    const wait = 1000 * Math.pow(2, attempt); // 1s,2s,4s,8s,16s backoff
    console.log(`  429 rate-limited; backing off ${wait}ms…`);
    await sleep(wait);
    return getJson(url, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`HuggingFace API ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

async function fetchPage(offset, length) {
  const url = `${API}?dataset=${encodeURIComponent(DATASET)}&config=${CONFIG}&split=${SPLIT}&offset=${offset}&length=${length}`;
  const json = await getJson(url);
  return (json.rows ?? []).map((r) => r.row).filter(Boolean);
}

async function getTotal() {
  // datasets-server /info exposes per-split num_examples
  const info = await getJson(`${INFO}?dataset=${encodeURIComponent(DATASET)}&config=${CONFIG}`);
  const splits = info?.dataset_info?.splits ?? {};
  return splits[SPLIT]?.num_examples ?? 500;
}

async function main() {
  const total = await getTotal();
  // Page through the WHOLE split (5 requests for 500 rows — avoids per-row 429),
  // then stride-select evenly. Rows are grouped by repo, so a sequential head is
  // single-repo and size-skewed; striding gives repo/size diversity.
  console.log(
    `Fetching all ${total} rows of ${DATASET} (${SPLIT}) in pages of ${PAGE}, ` +
      `then striding to ${count}…`,
  );
  const all = [];
  for (let offset = 0; offset < total; offset += PAGE) {
    const rows = await fetchPage(offset, Math.min(PAGE, total - offset));
    all.push(...rows);
    await sleep(300); // gentle pacing between pages
  }

  const step = Math.max(1, Math.floor(all.length / count));
  const instances = [];
  for (let k = 0; k < count && k * step < all.length; k++) {
    const row = all[k * step];
    if (!row || !row.patch) continue;
    instances.push({
      instanceId: row.instance_id,
      repo: row.repo,
      problemStatement: row.problem_statement ?? '',
      patch: row.patch,
    });
  }

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUT, JSON.stringify(instances, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${instances.length} instances → ${OUT}`);
  console.log(`Next: hand-label tiers in scripts/classifier-validation/labels.json, then run`);
  console.log(`      npm run validate:classifier`);
}

main().catch((err) => {
  console.error('fetch-swebench failed:', err.message);
  process.exit(1);
});
