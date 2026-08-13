/**
 * scripts/google/engine-negate.mjs
 *
 * Google Ads NEGATE engine.
 * Implements RULE 1 (NEGATE_TERM) and RULE 2 (NEGATE_NGRAM) from P3 spec §2-3.
 *
 * Usage:
 *   node scripts/google/engine-negate.mjs \
 *     --from=YYYY-MM-DD --to=YYYY-MM-DD --conv-from=YYYY-MM-DD [--illustrative] [--insert]
 *
 * Without --insert: print-only, zero DB writes.
 * With --insert:    ACT cards written to google_recommendations (state=DRAFT).
 *                   Cannot combine with --illustrative.
 */

import { neon } from '@neondatabase/serverless';
import { posterior, probRateBelow, fourState } from '../../lib/google/stats.mjs';

// ── Hard constants ─────────────────────────────────────────────────────────────
const CAMPAIGN_ID   = '20484759961';   // S I libros/ES
const CUSTOMER_ID   = '2199803274';
const EXPECTED_HOST = 'ep-holy-star-afsf5u86';

const BRAND_LIST = ['cuento de luz', 'cuentodeluz', 'cuentos de luz'];

const STOPWORDS = new Set([
  'de','la','el','para','con','los','las','y','en','un','una',
  'del','al','por','que','se','mi','tu','su',
]);

// Gate thresholds (P3 spec)
const CONV_ECON_CLICKS  = 25;   // gate1 for NEGATE_TERM
const NGRAM_MIN_CLICKS  = 40;   // entry + gate1 for NEGATE_NGRAM
const NGRAM_MIN_TERMS   = 5;
const NGRAM_MIN_SPEND   = 15;   // EUR
const TERM_MIN_SPEND    = 10;   // EUR
const M_PRIOR           = 30;
const PARENT_MIN_CONV   = 5;    // minimum campaign convs (from conv-from) to produce verdicts

// ── Arg parsing ────────────────────────────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const rawArgs = {};
for (const a of process.argv.slice(2)) {
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  if (eq === -1) rawArgs[a.slice(2)] = true;
  else           rawArgs[a.slice(2, eq)] = a.slice(eq + 1);
}

const fromDate   = rawArgs['from'];
const toDate     = rawArgs['to'];
const convFrom   = rawArgs['conv-from'];
const illustrative = !!rawArgs['illustrative'];
const insertMode   = !!rawArgs['insert'];

if (insertMode && illustrative) {
  console.error('REFUSED: illustrative data must never become cards');
  process.exit(1);
}

if (!fromDate || !DATE_RE.test(fromDate)) {
  console.error('ERROR: --from=YYYY-MM-DD required'); process.exit(1);
}
if (!toDate   || !DATE_RE.test(toDate))   {
  console.error('ERROR: --to=YYYY-MM-DD required');   process.exit(1);
}
if (!convFrom || !DATE_RE.test(convFrom)) {
  console.error('ERROR: --conv-from=YYYY-MM-DD required'); process.exit(1);
}

// ── DB / env guards ────────────────────────────────────────────────────────────
const dbUrl = process.env.GOOGLE_DATABASE_URL;
if (!dbUrl || !dbUrl.includes(EXPECTED_HOST)) {
  console.error(
    `FATAL: GOOGLE_DATABASE_URL missing or points to wrong endpoint\n` +
    `  expected host: ${EXPECTED_HOST}`
  );
  process.exit(1);
}
const sql = neon(dbUrl);

// Customer hard guard
const acctRows = await sql`
  SELECT customer_id FROM google_accounts WHERE customer_id = ${CUSTOMER_ID} LIMIT 1
`;
if (acctRows.length === 0) {
  console.error(`FATAL: customer ${CUSTOMER_ID} not found — wrong database?`);
  process.exit(1);
}

// ── Header ─────────────────────────────────────────────────────────────────────
console.log(`\nENGINE DRY RUN ${fromDate}..${toDate} conv-from=${convFrom}`);
if (illustrative) {
  console.log('MODE: ILLUSTRATIVE — pre-signal era, NOT ACTIONABLE');
}
if (insertMode) {
  console.log('MODE: INSERT — ACT cards will be written to google_recommendations as DRAFT');
}

// ── Load data ──────────────────────────────────────────────────────────────────

// Per-term aggregates: full window for clicks/impr/cost; conv only from conv-from
const termRows = await sql`
  SELECT
    search_term,
    ad_group_id::text                                                        AS ag_id,
    SUM(impressions)::bigint                                                 AS impr,
    SUM(clicks)::bigint                                                      AS clicks,
    SUM(cost_micros)                                                         AS cost_micros,
    SUM(CASE WHEN date >= ${convFrom}::date THEN conversions ELSE 0 END)     AS conv
  FROM google_search_term_daily
  WHERE campaign_id = ${CAMPAIGN_ID}::bigint
    AND date BETWEEN ${fromDate}::date AND ${toDate}::date
  GROUP BY search_term, ad_group_id
`;

// Ad-group totals for parent rate
const agTotalRows = await sql`
  SELECT
    ad_group_id::text                                                        AS ag_id,
    SUM(clicks)::bigint                                                      AS clicks,
    SUM(CASE WHEN date >= ${convFrom}::date THEN conversions ELSE 0 END)     AS conv
  FROM google_search_term_daily
  WHERE campaign_id = ${CAMPAIGN_ID}::bigint
    AND date BETWEEN ${fromDate}::date AND ${toDate}::date
  GROUP BY ad_group_id
`;

// Campaign totals (fallback parent rate)
const [campRow] = await sql`
  SELECT
    SUM(clicks)::bigint                                                      AS clicks,
    SUM(CASE WHEN date >= ${convFrom}::date THEN conversions ELSE 0 END)     AS conv
  FROM google_search_term_daily
  WHERE campaign_id = ${CAMPAIGN_ID}::bigint
    AND date BETWEEN ${fromDate}::date AND ${toDate}::date
`;

const campClicks     = Number(campRow.clicks) || 0;
const campConvs      = Number(campRow.conv)   || 0;
const campParentRate = campClicks > 0 ? campConvs / campClicks : 0;

// Parent data sufficiency guard
if (campConvs < PARENT_MIN_CONV) {
  console.log(
    `PARENT DATA INSUFFICIENT: ${campConvs} conversions since ${convFrom}` +
    ` (< ${PARENT_MIN_CONV} required). No verdicts possible; all rules stand down.`
  );
  console.log(`\nRULE 1 (NEGATE_TERM)`);
  console.log(`  terms=0 | brand=0 | below_spend=0 | evaluated=0`);
  console.log(`  of evaluated: ACT 0 / WATCH 0 / NEUTRAL 0 / INSUFFICIENT 0`);
  console.log(`\nRULE 2 (NEGATE_NGRAM)`);
  console.log(`  grams=0 | failed_entry=0 (clicks/terms/spend) | in_keyword=0 | evaluated=0`);
  console.log(`  of evaluated: ACT 0 / WATCH 0 / NEUTRAL 0 / INSUFFICIENT 0`);
  console.log(`\nTOTAL candidate cards: 0`);
  process.exit(0);
}

// Build per-ag parent rates (ag qualifies for own rate only if conv >= 5 AND clicks >= 50)
const agRateMap = {};
for (const r of agTotalRows) {
  const c = Number(r.clicks) || 0;
  const v = Number(r.conv)   || 0;
  agRateMap[r.ag_id] = (v >= 5 && c >= 50) ? v / c : campParentRate;
}

// Active positive keyword texts — for NGRAM guard
const kwRows = await sql`
  SELECT LOWER(k.text) AS kw_text
  FROM google_keywords k
  JOIN google_ad_groups ag USING (ad_group_id)
  WHERE ag.campaign_id = ${CAMPAIGN_ID}::bigint
    AND k.status       = 'ENABLED'
    AND k.negative     = false
`;
const kwTexts = kwRows.map(r => r.kw_text);

// Print window stats
const convRateStr = campConvs > 0 ? (campConvs / campClicks).toFixed(5) : '0';
console.log(
  `  terms_in_window=${termRows.length}` +
  ` | camp_clicks=${campClicks}` +
  ` | camp_conv(>=${convFrom})=${campConvs}` +
  ` | parent_rate=${convRateStr}` +
  ` | active_kw=${kwTexts.length}`
);

// ── Helpers ────────────────────────────────────────────────────────────────────

/** True if a search term contains a brand name. */
function isBrand(term) {
  const t = term.toLowerCase();
  return BRAND_LIST.some(b => t.includes(b));
}

/**
 * Tokenise a string: lowercase, strip non-Spanish-alpha, split on whitespace,
 * drop tokens shorter than 2 chars and stopwords.
 */
function tokenise(text) {
  return text
    .toLowerCase()
    .replace(/[^a-záéíóúüñ\s]/g, ' ')
    .split(/\s+/)
    .filter(tok => tok.length >= 2 && !STOPWORDS.has(tok));
}

/**
 * Extract unigrams and bigrams from a search term.
 * Both tokens of a bigram must be non-stopword.
 */
function extractGrams(term) {
  const toks = tokenise(term);
  const grams = new Set();
  for (const t of toks) grams.add(t);
  for (let i = 0; i < toks.length - 1; i++) {
    grams.add(`${toks[i]} ${toks[i + 1]}`);
  }
  return grams;
}

/**
 * True if `gram` (space-separated tokens) appears as a contiguous word sequence
 * in any active positive keyword text.
 */
function gramInKeyword(gram) {
  const gToks = gram.split(' ');
  return kwTexts.some(kw => {
    const kToks = kw.split(/\s+/);
    if (gToks.length === 1) return kToks.includes(gToks[0]);
    for (let i = 0; i <= kToks.length - gToks.length; i++) {
      if (gToks.every((g, j) => kToks[i + j] === g)) return true;
    }
    return false;
  });
}

/** Format one ACT/WATCH detail line. */
function fmtCard(c) {
  return (
    `  ${c.rule} | ${c.state}` +
    ` | "${c.entity}"` +
    ` | clicks=${c.clicks}` +
    ` | cost_eur=${c.costEur.toFixed(2)}` +
    ` | conv=${c.conv}` +
    ` | post(α=${c.alpha.toFixed(3)},β=${c.beta.toFixed(3)},mean=${c.pointEstimate.toFixed(5)})` +
    ` | P(below)=${c.pBelow.toFixed(4)}` +
    ` | ${c.whyLine}`
  );
}

// ── RULE 1 — NEGATE_TERM ──────────────────────────────────────────────────────
const r1 = { ACT: 0, WATCH: 0, NEUTRAL: 0, INSUFFICIENT: 0 };
const r1Cards = [];
const r1Total = termRows.length;
let r1Brand = 0, r1BelowSpend = 0, r1EntryCount = 0;

for (const row of termRows) {
  const clicks  = Number(row.clicks);
  const costEur = Number(row.cost_micros) / 1e6;
  const conv    = Number(row.conv);
  const term    = row.search_term;
  const agId    = row.ag_id;

  if (isBrand(term))            { r1Brand++;      continue; }  // brand guard first
  if (costEur < TERM_MIN_SPEND) { r1BelowSpend++; continue; }  // spend gate
  r1EntryCount++;

  const parentRate = agRateMap[agId] ?? campParentRate;
  const gate1Met   = clicks >= CONV_ECON_CLICKS;

  const { alpha, beta, pointEstimate } = posterior(conv, clicks, parentRate, M_PRIOR);
  const pBelow  = probRateBelow(0.5 * parentRate, alpha, beta);
  const state   = fourState(pBelow, gate1Met);
  r1[state]++;

  if (state === 'ACT' || state === 'WATCH') {
    const whyLine =
      `${conv}c/${clicks}clk/€${costEur.toFixed(2)}` +
      ` — P(rate<${(0.5 * parentRate).toFixed(5)})=${pBelow.toFixed(4)}` +
      ` — parent=${parentRate.toFixed(5)}` +
      ` — gate1(≥${CONV_ECON_CLICKS}clk)=${gate1Met}`;
    r1Cards.push({ rule: 'NEGATE_TERM', state, entity: term, agId, clicks, costEur, conv, alpha, beta, pointEstimate, pBelow, whyLine, parentRate });
  }
}

// ── RULE 2 — NEGATE_NGRAM ─────────────────────────────────────────────────────
// Pool per-gram stats across all non-brand terms
const gramMap = {};

for (const row of termRows) {
  if (isBrand(row.search_term)) continue;

  const clicks  = Number(row.clicks);
  const costEur = Number(row.cost_micros) / 1e6;
  const conv    = Number(row.conv);

  for (const gram of extractGrams(row.search_term)) {
    if (!gramMap[gram]) gramMap[gram] = { clicks: 0, costEur: 0, conv: 0, terms: new Map() };
    gramMap[gram].clicks  += clicks;
    gramMap[gram].costEur += costEur;
    gramMap[gram].conv    += conv;
    gramMap[gram].terms.set(row.search_term, (gramMap[gram].terms.get(row.search_term) || 0) + clicks);
  }
}

const r2 = { ACT: 0, WATCH: 0, NEUTRAL: 0, INSUFFICIENT: 0 };
const r2Cards = [];
const r2TotalGrams = Object.keys(gramMap).length;
let r2FailedEntry = 0, r2InKeyword = 0, r2EntryCount = 0;

for (const [gram, stats] of Object.entries(gramMap)) {
  const { clicks, costEur, conv, terms } = stats;

  if (clicks < NGRAM_MIN_CLICKS || terms.size < NGRAM_MIN_TERMS || costEur < NGRAM_MIN_SPEND) {
    r2FailedEntry++; continue;                                 // clicks/terms/spend gate
  }
  if (gramInKeyword(gram)) { r2InKeyword++; continue; }        // active keyword guard
  r2EntryCount++;

  // gate1Met is trivially true: clicks >= NGRAM_MIN_CLICKS already verified
  const { alpha, beta, pointEstimate } = posterior(conv, clicks, campParentRate, M_PRIOR);
  const pBelow = probRateBelow(0.5 * campParentRate, alpha, beta);
  const state  = fourState(pBelow, /* gate1Met= */ true);
  r2[state]++;

  if (state === 'ACT' || state === 'WATCH') {
    const whyLine =
      `${conv}c/${clicks}clk/€${costEur.toFixed(2)} pooled/${terms.size}terms` +
      ` — P(rate<${(0.5 * campParentRate).toFixed(5)})=${pBelow.toFixed(4)}` +
      ` — parent=${campParentRate.toFixed(5)}`;
    const constituents = [...stats.terms.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([t]) => t);
    r2Cards.push({ rule: 'NEGATE_NGRAM', state, entity: gram, clicks, costEur, conv, alpha, beta, pointEstimate, pBelow, whyLine, constituents, parentRate: campParentRate });
  }
}

// ── Output ─────────────────────────────────────────────────────────────────────
console.log(`\nRULE 1 (NEGATE_TERM)`);
console.log(`  terms=${r1Total} | brand=${r1Brand} | below_spend=${r1BelowSpend} | evaluated=${r1EntryCount}`);
console.log(`  of evaluated: ACT ${r1.ACT} / WATCH ${r1.WATCH} / NEUTRAL ${r1.NEUTRAL} / INSUFFICIENT ${r1.INSUFFICIENT}`);
for (const c of r1Cards) console.log(fmtCard(c));

console.log(`\nRULE 2 (NEGATE_NGRAM)`);
console.log(`  grams=${r2TotalGrams} | failed_entry=${r2FailedEntry} (clicks/terms/spend) | in_keyword=${r2InKeyword} | evaluated=${r2EntryCount}`);
console.log(`  of evaluated: ACT ${r2.ACT} / WATCH ${r2.WATCH} / NEUTRAL ${r2.NEUTRAL} / INSUFFICIENT ${r2.INSUFFICIENT}`);
for (const c of r2Cards) console.log(fmtCard(c));

console.log(`\nTOTAL candidate cards: ${r1Cards.length + r2Cards.length}`);

// ── Insert mode ────────────────────────────────────────────────────────────────
if (insertMode) {
  const runId    = 'run-' + new Date().toISOString().slice(0, 10);
  const actCards = [...r1Cards, ...r2Cards].filter(c => c.state === 'ACT');
  let inserted = 0, skipped = 0;

  console.log(`\nINSERT MODE: run_id=${runId} | ACT cards to write=${actCards.length}`);

  for (const c of actCards) {
    const isNgram   = c.rule === 'NEGATE_NGRAM';
    const agId      = isNgram ? null : c.agId;
    const matchType = isNgram ? 'PHRASE' : 'EXACT';
    const level     = isNgram ? 'CAMPAIGN' : 'AD_GROUP';
    const target    = isNgram ? CAMPAIGN_ID : c.agId;

    const actionJson = JSON.stringify({
      type: 'negative_keyword',
      level,
      target,
      match_type: matchType,
    });

    const evidenceBase = {
      window:         `${fromDate}..${toDate}`,
      conv_from:      convFrom,
      clicks:         c.clicks,
      cost_eur:       +c.costEur.toFixed(2),
      conv:           c.conv,
      posterior_mean: +c.pointEstimate.toFixed(6),
      p_below:        +c.pBelow.toFixed(6),
      parent_rate:    +c.parentRate.toFixed(6),
      threshold:      +(0.5 * c.parentRate).toFixed(6),
    };
    if (isNgram) evidenceBase.constituents = c.constituents;
    const evidenceJson = JSON.stringify(evidenceBase);

    const rows = await sql`
      INSERT INTO google_recommendations
        (state, run_id, rec_type, customer_id, campaign_id, ad_group_id,
         entity_key, action, evidence, why_line)
      VALUES
        ('DRAFT', ${runId}, ${c.rule}, ${CUSTOMER_ID}, ${CAMPAIGN_ID}, ${agId},
         ${c.entity}, ${actionJson}::jsonb, ${evidenceJson}::jsonb, ${c.whyLine})
      ON CONFLICT (rec_type, customer_id, coalesce(campaign_id,0), coalesce(ad_group_id,0), entity_key) WHERE state IN ('DRAFT','APPROVED') DO NOTHING
      RETURNING entity_key
    `;
    if (rows.length > 0) inserted++; else skipped++;
  }

  console.log(`INSERTED ${inserted} / SKIPPED ${skipped} (open rec exists)`);
}
