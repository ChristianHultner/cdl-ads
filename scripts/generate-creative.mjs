// scripts/generate-creative.mjs
// Usage: node scripts/generate-creative.mjs --profile <id> [--mode keywords|targets] [--execute]
//
// ENV required (sourced by caller):
//   DATABASE_URL         — Neon connection string
//   ANTHROPIC_API_KEY    — source ~/secrets/cdl-ads-anthropic.env
//   CDL_BOOKS_API_KEY    — source ~/secrets/cdl-ads-books.env
//
// Dry-run default: prints assembled prompt + raw model response + validated
// candidates but INSERTs nothing. Pass --execute to insert into recommendations.
//
// --mode keywords  (default) CREATIVE_KEYWORD path — existing behavior, untouched.
// --mode targets             CREATIVE_TARGET path  — propose competitor children's
//                            books to target as product ads.
//
// Pilot market: US. Cap: 10 recs per run.
//
// Books API shape (confirmed 2026-07-27 by first-contact probe):
//   GET /api/v1/books/public?isbns=<comma-separated>  ← isbns param required
//   No bare catalog endpoint exists. ASINs are sourced from amazon_product_ads
//   for the profile and batch-fetched 20 at a time.

import { parseArgs } from 'node:util';
import { Pool, neonConfig } from '@neondatabase/serverless';

// Node 22+ native WebSocket
neonConfig.webSocketConstructor = WebSocket;

// ── Args ──────────────────────────────────────────────────────────────────────
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    profile: { type: 'string' },
    execute: { type: 'boolean', default: false },
    mode:    { type: 'string',  default: 'keywords' },
  },
});
if (!values.profile) throw new Error('--profile <id> required');
const runMode = values.mode ?? 'keywords';
if (!['keywords', 'targets'].includes(runMode))
  throw new Error('--mode must be "keywords" or "targets"');
const profileId    = BigInt(values.profile);
const profileIdStr = String(profileId);
const executeMode  = values.execute === true;

// ── 1. ENV validation ─────────────────────────────────────────────────────────
const { DATABASE_URL, ANTHROPIC_API_KEY, CDL_BOOKS_API_KEY } = process.env;
const missingEnv = [];
if (!DATABASE_URL)      missingEnv.push('DATABASE_URL');
if (!ANTHROPIC_API_KEY) missingEnv.push('ANTHROPIC_API_KEY');
if (!CDL_BOOKS_API_KEY) missingEnv.push('CDL_BOOKS_API_KEY');
if (missingEnv.length) {
  console.error(`Missing required env vars: ${missingEnv.join(', ')}`);
  process.exit(1);
}

// ── DB ────────────────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: DATABASE_URL });

const CDL_BOOKS_API_URL = process.env.CDL_BOOKS_API_URL ?? 'https://books.cuentodeluz.com';
const BOOKS_BATCH_SIZE  = 20;
const TITLE_CAP         = 100;
const BID_MIN           = 0.20;
const BID_MAX           = 0.50;
const REC_CAP           = 10;

console.log(executeMode
  ? 'EXECUTE MODE — will INSERT approved candidates'
  : 'DRY RUN — no INSERTs will be made');
console.log(`Mode: ${runMode}`);
console.log('');

// ── 2a. CATALOG via Books API (batch by profile ASINs) ────────────────────────
// Endpoint requires ?isbns=<comma-sep>; pull ASINs from amazon_product_ads.
const { rows: asinRows } = await pool.query(
  `SELECT DISTINCT asin::text
     FROM amazon_product_ads
    WHERE profile_id = $1
      AND asin IS NOT NULL
    ORDER BY asin`,
  [profileId],
);

const allAsins = asinRows.map(r => r.asin);
console.log(`Catalog: ${allAsins.length} distinct ASINs for profile ${profileIdStr}`);

/** @type {{ asin: string; title: string; language: string|null }[]} */
const catalogTitles = [];

for (let i = 0; i < allAsins.length && catalogTitles.length < TITLE_CAP; i += BOOKS_BATCH_SIZE) {
  const batch = allAsins.slice(i, i + BOOKS_BATCH_SIZE);
  let res;
  try {
    res = await fetch(
      `${CDL_BOOKS_API_URL}/api/v1/books/public?isbns=${encodeURIComponent(batch.join(','))}`,
      {
        headers: {
          'X-Api-Key': CDL_BOOKS_API_KEY,
          Accept:      'application/json',
          ...(process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
            ? {
                'CF-Access-Client-Id':     process.env.CF_ACCESS_CLIENT_ID,
                'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET,
              }
            : {}),
        },
      },
    );
  } catch (err) {
    console.warn(`Books API fetch error (batch ${i}): ${err.message}`);
    continue;
  }

  if (!res.ok) {
    const text = await res.text();
    console.warn(`Books API HTTP ${res.status} (batch ${i}): ${text.slice(0, 200)}`);
    continue;
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    console.warn(`Books API JSON parse error (batch ${i}): ${err.message}`);
    continue;
  }

  if (!Array.isArray(body.books)) {
    console.warn(`Books API unexpected shape (batch ${i}): ${JSON.stringify(body).slice(0, 200)}`);
    continue;
  }

  for (const book of body.books) {
    if (book?.found && book.title) {
      catalogTitles.push({
        asin:     book.asin ?? '',
        title:    book.title,
        language: book.language ?? null,
      });
      if (catalogTitles.length >= TITLE_CAP) break;
    }
  }

  if (i + BOOKS_BATCH_SIZE < allAsins.length) {
    await new Promise(r => setTimeout(r, 100));
  }
}

console.log(`Catalog: ${catalogTitles.length} title(s) collected`);

// ── MODE BRANCH ───────────────────────────────────────────────────────────────
// keywords (default) — CREATIVE_KEYWORD, existing behavior untouched.
// targets            — CREATIVE_TARGET, new path.
// ─────────────────────────────────────────────────────────────────────────────

if (runMode === 'keywords') {

  // ── 2b. EXISTING ENABLED KEYWORDS (dedupe set) ──────────────────────────────
  const { rows: kwRows } = await pool.query(
    `SELECT keyword_text::text
       FROM amazon_keywords
      WHERE profile_id = $1
        AND state      = 'ENABLED'`,
    [profileId],
  );
  const existingKeywordSet = new Set(kwRows.map(r => r.keyword_text.toLowerCase().trim()));
  console.log(`Existing ENABLED keywords: ${existingKeywordSet.size}`);

  // ── 2c. OPEN RECS — PROMOTE_TERM / CREATIVE_KEYWORD (dedupe set) ────────────
  const { rows: openRecRows } = await pool.query(
    `SELECT target_text::text
       FROM recommendations
      WHERE profile_id = $1
        AND rec_type   = ANY (ARRAY['PROMOTE_TERM'::text, 'CREATIVE_KEYWORD'::text])
        AND status     = ANY (ARRAY['DRAFT'::text, 'APPROVED'::text])`,
    [profileId],
  );
  const openRecSet = new Set(openRecRows.map(r => r.target_text.toLowerCase().trim()));
  console.log(`Open PROMOTE_TERM/CREATIVE_KEYWORD recs: ${openRecSet.size}`);

  // ── 2d. ELIGIBLE ROOMS: MANUAL campaigns, ENABLED ad groups, ≥1 ENABLED kw ──
  const { rows: roomRows } = await pool.query(
    `SELECT ag.ad_group_id::text,
            ag.name::text     AS ad_group_name,
            ag.campaign_id::text
       FROM amazon_ad_groups  ag
       JOIN amazon_campaigns   c  ON c.campaign_id = ag.campaign_id
                                  AND c.profile_id  = ag.profile_id
      WHERE ag.profile_id      = $1
        AND c.targeting_type   = 'MANUAL'
        AND c.state            = 'ENABLED'
        AND ag.state           = 'ENABLED'
        AND EXISTS (
              SELECT 1
                FROM amazon_keywords k
               WHERE k.profile_id  = $1
                 AND k.ad_group_id = ag.ad_group_id
                 AND k.state       = 'ENABLED'
            )
      ORDER BY ag.name`,
    [profileId],
  );
  const roomMap = new Map(roomRows.map(r => [r.ad_group_id, r]));
  console.log(`Eligible rooms (MANUAL, ENABLED, ≥1 ENABLED kw): ${roomRows.length}`);

  // ── 2e. PERFORMANCE FLAVOR — top 15 search terms by orders (60d) ─────────────
  const cutoffDate = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
  const { rows: perfRows } = await pool.query(
    `SELECT search_term::text,
            SUM(purchases_14d) AS orders,
            SUM(cost)          AS spend
       FROM amazon_search_term_daily
      WHERE profile_id = $1
        AND date       >= $2
      GROUP BY search_term
      ORDER BY SUM(purchases_14d) DESC, SUM(cost) DESC
      LIMIT 15`,
    [profileId, cutoffDate],
  );
  console.log(`Performance search terms (60d): ${perfRows.length}`);
  console.log('');

  // ── 3. ASSEMBLE PROMPT (keywords) ─────────────────────────────────────────────
  const titleLines = catalogTitles.length
    ? catalogTitles
        .map(t => `  - "${t.title}"${t.language ? ` [${t.language}]` : ''}`)
        .join('\n')
    : '  (no titles found — no ASINs for this profile or Books API unavailable)';

  const kwLines = existingKeywordSet.size
    ? [...existingKeywordSet].slice(0, 300).map(k => `  - ${k}`).join('\n')
    : '  (none)';

  const openRecLines = openRecSet.size
    ? [...openRecSet].map(k => `  - ${k}`).join('\n')
    : '  (none)';

  const roomLines = roomRows.length
    ? roomRows
        .map(r => `  - ad_group_id: ${r.ad_group_id} | name: ${r.ad_group_name} | campaign_id: ${r.campaign_id}`)
        .join('\n')
    : '  (none — no eligible MANUAL ad groups with ENABLED keywords)';

  const perfLines = perfRows.length
    ? perfRows
        .map(r => `  - "${r.search_term}" (orders: ${r.orders}, spend: $${Number(r.spend).toFixed(2)})`)
        .join('\n')
    : '  (none)';

  const systemPrompt =
    'You are an Amazon Ads keyword strategist for Cuento de Luz, a Spanish children\'s book publisher selling in the US. ' +
    'Given their catalog, current keywords, and top-performing search terms, propose NEW exact-match keywords real US shoppers ' +
    'would type that are NOT already covered. Favor specific, purchase-intent phrases (themes, occasions, age bands, bilingual angles) ' +
    'over generic terms. Return ONLY a JSON array, no prose: ' +
    '[{"keyword": string, "rationale": string (<=140 chars), "suggested_bid": number (0.20-0.50), ' +
    '"destination_ad_group_id": string (choose from the provided rooms list), "confidence": "high"|"medium"}] — max 10 items.';

  const userMessage = [
    '=== CATALOG (up to 100 CdL titles) ===',
    titleLines,
    '',
    '=== EXISTING ENABLED KEYWORDS (do NOT repeat these) ===',
    kwLines,
    '',
    '=== OPEN RECOMMENDATIONS — PROMOTE_TERM / CREATIVE_KEYWORD (do NOT repeat these) ===',
    openRecLines,
    '',
    '=== ELIGIBLE AD GROUPS (rooms — destination_ad_group_id MUST come from this list) ===',
    roomLines,
    '',
    '=== TOP 15 SEARCH TERMS BY ORDERS (last 60 days — what already converts) ===',
    perfLines,
  ].join('\n');

  console.log('=== ASSEMBLED PROMPT (system) ===');
  console.log(systemPrompt);
  console.log('');
  console.log('=== ASSEMBLED PROMPT (user message) ===');
  console.log(userMessage);
  console.log('');

  // ── API CALL ──────────────────────────────────────────────────────────────────
  console.log('Calling Anthropic API (claude-sonnet-4-5)…');
  let apiResponse;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-5',
        max_tokens: 2000,
        system:     systemPrompt,
        messages: [
          { role: 'user', content: userMessage },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    apiResponse = await res.json();
  } catch (err) {
    console.error(`Anthropic API error: ${err.message}`);
    await pool.end();
    process.exit(1);
  }

  const rawContent = apiResponse?.content?.[0]?.text ?? '';
  console.log('');
  console.log('=== RAW MODEL RESPONSE ===');
  console.log(rawContent);
  console.log('');

  // ── 4. VALIDATION GAUNTLET (keywords) ─────────────────────────────────────────
  const stripped = rawContent
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    console.error(`JSON parse failed: ${err.message}`);
    console.error(`Stripped content (first 500): ${stripped.slice(0, 500)}`);
    await pool.end();
    process.exit(1);
  }

  if (!Array.isArray(parsed)) {
    console.error(`Expected JSON array from model, got: ${typeof parsed}`);
    await pool.end();
    process.exit(1);
  }

  /** @type {{ keyword: string; rationale: string; suggested_bid: number; destination_ad_group_id: string; destination_ad_group_name: string; confidence: string }[]} */
  const validated = [];
  /** @type {{ item: unknown; reason: string }[]} */
  const rejected  = [];

  for (const item of parsed) {
    if (validated.length >= REC_CAP) {
      rejected.push({ item, reason: 'cap reached (10)' });
      continue;
    }

    const kw = (typeof item.keyword === 'string')
      ? item.keyword.toLowerCase().trim()
      : null;

    if (!kw) {
      rejected.push({ item, reason: 'missing or non-string keyword' });
      continue;
    }

    const wordCount = kw.split(/\s+/).filter(Boolean).length;
    if (wordCount < 2 || wordCount > 6) {
      rejected.push({ item: kw, reason: `word count ${wordCount} out of range [2,6]` });
      continue;
    }

    if (existingKeywordSet.has(kw)) {
      rejected.push({ item: kw, reason: 'duplicate of existing ENABLED keyword' });
      continue;
    }

    if (openRecSet.has(kw)) {
      rejected.push({ item: kw, reason: 'duplicate of open recommendation' });
      continue;
    }

    const destRoom = roomMap.get(item.destination_ad_group_id);
    if (!destRoom) {
      rejected.push({ item: kw, reason: `destination_ad_group_id "${item.destination_ad_group_id}" not in eligible rooms` });
      continue;
    }

    if (!['high', 'medium'].includes(item.confidence)) {
      rejected.push({ item: kw, reason: `invalid confidence value "${item.confidence}"` });
      continue;
    }

    const rawBid = Number(item.suggested_bid);
    const bid    = Math.max(BID_MIN, Math.min(BID_MAX, isNaN(rawBid) ? BID_MIN : rawBid));

    const rationale = (typeof item.rationale === 'string')
      ? item.rationale.slice(0, 140)
      : '';

    validated.push({
      keyword:                   kw,
      rationale,
      suggested_bid:             bid,
      destination_ad_group_id:   item.destination_ad_group_id,
      destination_ad_group_name: destRoom.ad_group_name,
      confidence:                item.confidence,
    });
  }

  console.log('=== VALIDATED CANDIDATES ===');
  if (validated.length === 0) {
    console.log('  (none passed validation)');
  } else {
    for (const v of validated) {
      console.log(`  ✓ "${v.keyword}"`);
      console.log(`    → ${v.destination_ad_group_name} (${v.destination_ad_group_id})`);
      console.log(`    → bid=$${v.suggested_bid.toFixed(2)}, conf=${v.confidence}`);
      console.log(`    → rationale: ${v.rationale}`);
    }
  }
  console.log('');

  if (rejected.length) {
    console.log('=== REJECTED ===');
    for (const r of rejected) {
      console.log(`  ✗ ${JSON.stringify(r.item)} — ${r.reason}`);
    }
    console.log('');
  }

  // ── 5. INSERT (--execute only, keywords) ──────────────────────────────────────
  const generatedAt  = new Date().toISOString();
  const contextStats = {
    titles:            catalogTitles.length,
    existing_keywords: existingKeywordSet.size,
    rooms:             roomRows.length,
  };

  let inserted  = 0;
  let idempotent = 0;

  if (executeMode) {
    for (const v of validated) {
      const { rows: dupRows } = await pool.query(
        `SELECT 1
           FROM recommendations
          WHERE profile_id  = $1
            AND target_text = $2
            AND status      = ANY (ARRAY['DRAFT'::text, 'APPROVED'::text])
          LIMIT 1`,
        [profileId, v.keyword],
      );
      if (dupRows.length) {
        console.log(`  SKIP (open rec exists): "${v.keyword}"`);
        idempotent++;
        continue;
      }

      const proposal = `Creative: '${v.keyword}' — ${v.rationale} (suggested $${v.suggested_bid.toFixed(2)}, ${v.confidence} confidence)`;
      const evidence = {
        keyword:                   v.keyword,
        rationale:                 v.rationale,
        suggested_bid:             v.suggested_bid,
        proposed_bid:              v.suggested_bid,
        destination_ad_group_id:   v.destination_ad_group_id,
        destination_ad_group_name: v.destination_ad_group_name,
        confidence:                v.confidence,
        model:                     'claude-sonnet-4-5',
        generated_at:              generatedAt,
        context_stats:             contextStats,
      };

      await pool.query(
        `INSERT INTO recommendations
           (rec_type, profile_id, target_text, proposal, evidence, status)
         VALUES ('CREATIVE_KEYWORD'::text, $1, $2, $3, $4::jsonb, 'DRAFT'::text)`,
        [profileId, v.keyword, proposal, JSON.stringify(evidence)],
      );

      console.log(`  INSERTED: "${v.keyword}"`);
      inserted++;
    }
  } else {
    console.log('DRY RUN — INSERTs skipped.');
    console.log(`Would insert up to ${validated.length} candidate(s) (idempotency check runs at execute time).`);
  }

  await pool.end();

  // ── 6. SUMMARY (keywords) ─────────────────────────────────────────────────────
  const rejByReason = /** @type {Record<string,number>} */ ({});
  for (const r of rejected) {
    rejByReason[r.reason] = (rejByReason[r.reason] ?? 0) + 1;
  }

  console.log('');
  console.log('─── SUMMARY ────────────────────────────────────────────────');
  console.log(`  Profile   : ${profileIdStr}`);
  console.log(`  Mode      : KEYWORDS (${executeMode ? 'EXECUTE' : 'DRY RUN'})`);
  console.log(`  Proposed  : ${parsed.length}`);
  for (const [reason, count] of Object.entries(rejByReason)) {
    console.log(`  Rejected (${reason}): ${count}`);
  }
  console.log(`  Validated : ${validated.length}`);
  if (executeMode) {
    console.log(`  Inserted  : ${inserted}`);
    console.log(`  Idempotent: ${idempotent}`);
  }
  console.log('────────────────────────────────────────────────────────────');

} else {
  // runMode === 'targets'

  // ── 2b-t. OWN ASINs — already in allAsins (upper-cased for dedupe) ───────────
  const ownAsinSet = new Set(allAsins.map(a => a.toUpperCase()));
  console.log(`Own ASINs (hard exclude): ${ownAsinSet.size}`);

  // ── 2c-t. ALREADY-TARGETED ASINs ─────────────────────────────────────────────
  const { rows: targetedRows } = await pool.query(
    `SELECT DISTINCT resolved_asin::text
       FROM amazon_targets
      WHERE profile_id    = $1
        AND resolved_asin IS NOT NULL`,
    [profileId],
  );
  const alreadyTargetedSet = new Set(targetedRows.map(r => r.resolved_asin.toUpperCase()));
  console.log(`Already-targeted ASINs: ${alreadyTargetedSet.size}`);

  // ── 2d-t. ELIGIBLE ROOMS — target-holding MANUAL groups ──────────────────────
  const { rows: roomRows } = await pool.query(
    `SELECT ag.ad_group_id::text,
            ag.name::text     AS ad_group_name,
            ag.campaign_id::text
       FROM amazon_ad_groups  ag
       JOIN amazon_campaigns   c  ON c.campaign_id = ag.campaign_id
                                  AND c.profile_id  = ag.profile_id
      WHERE ag.profile_id    = $1
        AND c.targeting_type = 'MANUAL'
        AND c.state          = 'ENABLED'
        AND ag.state         = 'ENABLED'
        AND EXISTS (
              SELECT 1
                FROM amazon_targets t
               WHERE t.profile_id    = $1
                 AND t.ad_group_id   = ag.ad_group_id
                 AND t.state         = 'ENABLED'
                 AND t.resolved_asin IS NOT NULL
            )
      ORDER BY ag.name`,
    [profileId],
  );
  const roomMap        = new Map(roomRows.map(r => [r.ad_group_id, r]));
  const noEligibleRoom = roomRows.length === 0;
  console.log(`Eligible rooms (product-targeting MANUAL, ENABLED, resolved_asin): ${roomRows.length}`);
  if (noEligibleRoom) {
    console.log('  NOTE: no product-targeting room — will orphan for CREATE_STRUCTURE');
  }

  // ── 2e-t. TOP 15 SEARCH TERMS (60d) ──────────────────────────────────────────
  const cutoffDate = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
  const { rows: perfRows } = await pool.query(
    `SELECT search_term::text,
            SUM(purchases_14d) AS orders,
            SUM(cost)          AS spend
       FROM amazon_search_term_daily
      WHERE profile_id = $1
        AND date       >= $2
      GROUP BY search_term
      ORDER BY SUM(purchases_14d) DESC, SUM(cost) DESC
      LIMIT 15`,
    [profileId, cutoffDate],
  );
  console.log(`Performance search terms (60d): ${perfRows.length}`);
  console.log('');

  // ── 3-t. ASSEMBLE PROMPT (targets) ────────────────────────────────────────────
  const titleLines = catalogTitles.length
    ? catalogTitles
        .map(t => `  - "${t.title}"${t.language ? ` [${t.language}]` : ''}`)
        .join('\n')
    : '  (no titles found)';

  const ownAsinLines = ownAsinSet.size
    ? [...ownAsinSet].map(a => `  - ${a}`).join('\n')
    : '  (none)';

  const alreadyTargetedLines = alreadyTargetedSet.size
    ? [...alreadyTargetedSet].map(a => `  - ${a}`).join('\n')
    : '  (none)';

  const roomLines = roomRows.length
    ? roomRows
        .map(r => `  - ad_group_id: ${r.ad_group_id} | name: ${r.ad_group_name} | campaign_id: ${r.campaign_id}`)
        .join('\n')
    : '  (none — no product-targeting room available; all proposals will be orphaned for CREATE_STRUCTURE)';

  const perfLines = perfRows.length
    ? perfRows
        .map(r => `  - "${r.search_term}" (orders: ${r.orders}, spend: $${Number(r.spend).toFixed(2)})`)
        .join('\n')
    : '  (none)';

  const systemPrompt =
    'You are an Amazon Ads strategist for Cuento de Luz, a Spanish children\'s book publisher selling on amazon.com. ' +
    'Propose REAL children\'s books currently sold on amazon.com whose buyers overlap this catalog — books to advertise on. ' +
    'NEVER propose the publisher\'s own books or already-targeted ones (lists provided). ' +
    'Return ONLY a JSON array: [{"title": string, "author": string, "rationale": string (<=140 chars), ' +
    '"suggested_bid": number (0.20-0.50), "destination_ad_group_id": string (from rooms list), ' +
    '"confidence": "high"|"medium"}] — max 10. Do NOT include ASINs — titles and authors only.';

  const userMessage = [
    '=== CATALOG (up to 100 CdL titles — NEVER propose these) ===',
    titleLines,
    '',
    '=== OWN ASINs (hard exclude — never propose a book with these ASINs) ===',
    ownAsinLines,
    '',
    '=== ALREADY-TARGETED ASINs (do NOT propose books with these ASINs) ===',
    alreadyTargetedLines,
    '',
    '=== ELIGIBLE AD GROUPS (rooms — destination_ad_group_id MUST come from this list) ===',
    roomLines,
    '',
    '=== TOP 15 SEARCH TERMS BY ORDERS (last 60 days — audience context) ===',
    perfLines,
  ].join('\n');

  console.log('=== ASSEMBLED PROMPT (system) ===');
  console.log(systemPrompt);
  console.log('');
  console.log('=== ASSEMBLED PROMPT (user message) ===');
  console.log(userMessage);
  console.log('');

  // ── API CALL ──────────────────────────────────────────────────────────────────
  console.log('Calling Anthropic API (claude-sonnet-4-5)…');
  let apiResponse;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-5',
        max_tokens: 2000,
        system:     systemPrompt,
        messages: [
          { role: 'user', content: userMessage },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    apiResponse = await res.json();
  } catch (err) {
    console.error(`Anthropic API error: ${err.message}`);
    await pool.end();
    process.exit(1);
  }

  const rawContent = apiResponse?.content?.[0]?.text ?? '';
  console.log('');
  console.log('=== RAW MODEL RESPONSE ===');
  console.log(rawContent);
  console.log('');

  // ── 4-t. VALIDATION GAUNTLET (targets) ────────────────────────────────────────
  // Rules: title+author nonempty; bid clamped [0.20,0.50]; destination in rooms;
  // title not a case-insensitive substring match of any catalog title; cap 10.
  const stripped = rawContent
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    console.error(`JSON parse failed: ${err.message}`);
    console.error(`Stripped content (first 500): ${stripped.slice(0, 500)}`);
    await pool.end();
    process.exit(1);
  }

  if (!Array.isArray(parsed)) {
    console.error(`Expected JSON array from model, got: ${typeof parsed}`);
    await pool.end();
    process.exit(1);
  }

  /** @type {{ title: string; author: string; rationale: string; suggested_bid: number; destination_ad_group_id: string; destination_ad_group_name: string; confidence: string }[]} */
  const validated = [];
  /** @type {{ item: unknown; reason: string }[]} */
  const rejected  = [];

  const catalogTitleLowers = catalogTitles.map(t => t.title.toLowerCase());

  for (const item of parsed) {
    if (validated.length >= REC_CAP) {
      rejected.push({ item, reason: 'cap reached (10)' });
      continue;
    }

    const title  = (typeof item.title  === 'string') ? item.title.trim()  : null;
    const author = (typeof item.author === 'string') ? item.author.trim() : null;

    if (!title || !author) {
      rejected.push({ item, reason: 'missing or empty title/author' });
      continue;
    }

    // Case-insensitive substring: reject if title overlaps any catalog title
    const titleLower = title.toLowerCase();
    const clashesWithCatalog = catalogTitleLowers.some(
      ct => ct.includes(titleLower) || titleLower.includes(ct),
    );
    if (clashesWithCatalog) {
      rejected.push({ item: title, reason: 'title matches catalog (own book)' });
      continue;
    }

    let destRoom = null;
    if (!noEligibleRoom) {
      destRoom = roomMap.get(item.destination_ad_group_id);
      if (!destRoom) {
        rejected.push({ item: title, reason: `destination_ad_group_id "${item.destination_ad_group_id}" not in eligible rooms` });
        continue;
      }
    }

    if (!['high', 'medium'].includes(item.confidence)) {
      rejected.push({ item: title, reason: `invalid confidence value "${item.confidence}"` });
      continue;
    }

    const rawBid = Number(item.suggested_bid);
    const bid    = Math.max(BID_MIN, Math.min(BID_MAX, isNaN(rawBid) ? BID_MIN : rawBid));

    const rationale = (typeof item.rationale === 'string')
      ? item.rationale.slice(0, 140)
      : '';

    validated.push({
      title,
      author,
      rationale,
      suggested_bid:             bid,
      destination_ad_group_id:   noEligibleRoom ? null : item.destination_ad_group_id,
      destination_ad_group_name: noEligibleRoom ? null : (destRoom?.ad_group_name ?? null),
      confidence:                item.confidence,
    });
  }

  console.log('=== VALIDATED CANDIDATES ===');
  if (validated.length === 0) {
    console.log('  (none passed validation)');
  } else {
    for (const v of validated) {
      console.log(`  ✓ "${v.title}" — ${v.author}`);
      if (v.destination_ad_group_id) {
        console.log(`    → ${v.destination_ad_group_name} (${v.destination_ad_group_id})`);
      } else {
        console.log(`    → (no product-targeting room — will orphan for CREATE_STRUCTURE)`);
      }
      console.log(`    → bid=$${v.suggested_bid.toFixed(2)}, conf=${v.confidence}`);
      console.log(`    → rationale: ${v.rationale}`);
    }
  }
  console.log('');

  if (rejected.length) {
    console.log('=== REJECTED ===');
    for (const r of rejected) {
      console.log(`  ✗ ${JSON.stringify(r.item)} — ${r.reason}`);
    }
    console.log('');
  }

  // ── 5-t. INSERT (--execute only, targets) ─────────────────────────────────────
  const generatedAt  = new Date().toISOString();
  const contextStats = {
    titles:           catalogTitles.length,
    own_asins:        ownAsinSet.size,
    already_targeted: alreadyTargetedSet.size,
    rooms:            roomRows.length,
  };

  let inserted  = 0;
  let idempotent = 0;

  if (executeMode) {
    for (const v of validated) {
      const targetText = `${v.title} — ${v.author}`;

      // Idempotency: skip if any open rec shares target_text
      const { rows: dupRows } = await pool.query(
        `SELECT 1
           FROM recommendations
          WHERE profile_id  = $1
            AND target_text = $2
            AND status      = ANY (ARRAY['DRAFT'::text, 'APPROVED'::text])
          LIMIT 1`,
        [profileId, targetText],
      );
      if (dupRows.length) {
        console.log(`  SKIP (open rec exists): "${targetText}"`);
        idempotent++;
        continue;
      }

      const proposal =
        `Creative target: '${v.title}' by ${v.author} — ${v.rationale} ` +
        `(suggested $${v.suggested_bid.toFixed(2)}, ${v.confidence}). ` +
        `VERIFY ON AMAZON BEFORE APPROVING — ASIN required at approval.`;

      const evidence = {
        title:                     v.title,
        author:                    v.author,
        rationale:                 v.rationale,
        suggested_bid:             v.suggested_bid,
        proposed_bid:              v.suggested_bid,
        destination_ad_group_id:   v.destination_ad_group_id,
        destination_ad_group_name: v.destination_ad_group_name,
        confidence:                v.confidence,
        asin:                      null,
        model:                     'claude-sonnet-4-5',
        generated_at:              generatedAt,
        context_stats:             contextStats,
      };

      await pool.query(
        `INSERT INTO recommendations
           (rec_type, profile_id, target_text, proposal, evidence, status)
         VALUES ('CREATIVE_TARGET'::text, $1, $2, $3, $4::jsonb, 'DRAFT'::text)`,
        [profileId, targetText, proposal, JSON.stringify(evidence)],
      );

      console.log(`  INSERTED: "${targetText}"`);
      inserted++;
    }
  } else {
    console.log('DRY RUN — INSERTs skipped.');
    console.log(`Would insert up to ${validated.length} candidate(s) (idempotency check runs at execute time).`);
  }

  await pool.end();

  // ── 6-t. SUMMARY (targets) ────────────────────────────────────────────────────
  const rejByReason = /** @type {Record<string,number>} */ ({});
  for (const r of rejected) {
    rejByReason[r.reason] = (rejByReason[r.reason] ?? 0) + 1;
  }

  console.log('');
  console.log('─── SUMMARY ────────────────────────────────────────────────');
  console.log(`  Profile   : ${profileIdStr}`);
  console.log(`  Mode      : TARGETS (${executeMode ? 'EXECUTE' : 'DRY RUN'})`);
  console.log(`  Proposed  : ${parsed.length}`);
  for (const [reason, count] of Object.entries(rejByReason)) {
    console.log(`  Rejected (${reason}): ${count}`);
  }
  console.log(`  Validated : ${validated.length}`);
  if (executeMode) {
    console.log(`  Inserted  : ${inserted}`);
    console.log(`  Idempotent: ${idempotent}`);
  }
  console.log('────────────────────────────────────────────────────────────');
}
