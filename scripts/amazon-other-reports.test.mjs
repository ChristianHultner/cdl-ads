// Offline-only coverage for product isolation, atomic ingestion and API errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { REPORTS, ingestTransaction, createApi } from '../lib/amazon/sync-runner.ts';

const row = { campaignId: '123', campaignName: 'Example', date: '2026-09-01', impressions: 10, clicks: 2, cost: 1.5, purchases: 1, sales: 12 };

test('SB and SD use distinct products and preserve raw attribution metrics', () => {
  for (const [type, product, adProduct] of [['sbCampaigns','SB','SPONSORED_BRANDS'], ['sdCampaigns','SD','SPONSORED_DISPLAY']]) {
    const spec = REPORTS[type];
    assert.equal(spec.configuration.adProduct, adProduct);
    assert.equal(spec.configuration.reportTypeId, type);
    assert.deepEqual(spec.configuration.groupBy, ['campaign']);
    assert.equal(spec.configuration.timeUnit, 'DAILY');
    assert.equal(spec.configuration.format, 'GZIP_JSON');
    assert.deepEqual(spec.values('456', row), ['456', product, '123', '2026-09-01', 10, 2, 1.5, 1, 12, row]);
    assert.match(spec.conflict, /profile_id, ad_product, campaign_id, date/);
    assert.throws(() => spec.values('456', { ...row, purchases: undefined }), /required metrics missing/);
    assert.throws(() => spec.values('456', { ...row, sales: 'not a number' }), /required metrics missing/);
  }
});

test('SP campaign configuration and landing table stay unchanged', () => {
  assert.deepEqual(REPORTS.spCampaigns.configuration.columns, ['campaignId','date','impressions','clicks','cost','purchases14d','sales14d']);
  assert.match(REPORTS.spCampaigns.insert, /INSERT INTO amazon_campaign_daily\s/);
  assert.doesNotMatch(REPORTS.spCampaigns.insert, /daily_other/);
});

test('landing and INGESTED receipt commit atomically; bad rows roll back', async () => {
  for (const invalid of [false, true]) {
    const queries = [];
    const client = { async query(sql) { queries.push(sql); return { rows: sql.includes('FOR UPDATE') ? [{ status: 'PENDING' }] : [] }; } };
    const request = { report_id: 'r', profile_id: '456', report_type: 'sbCampaigns', status: 'PENDING', expired: false };
    const work = ingestTransaction(client, request, [{ ...row, ...(invalid ? { purchases: null } : {}) }], Date.now() + 30000);
    if (invalid) {
      await assert.rejects(work);
      assert.equal(queries.at(-1), 'ROLLBACK');
      assert.ok(!queries.some(sql => sql.includes("status = 'INGESTED'")));
    } else {
      assert.equal(await work, 1);
      assert.equal(queries.at(-1), 'COMMIT');
      assert.ok(queries.some(sql => sql.includes('INSERT INTO amazon_campaign_daily_other')));
      assert.ok(queries.some(sql => sql.includes("status = 'INGESTED'")));
    }
  }
});

test('empty completed reports get coverage receipts, already ingested reports are not rewritten', async () => {
  for (const status of ['PENDING','INGESTED']) {
    const queries = [];
    const client = { async query(sql) { queries.push(sql); return { rows: [{ status }] }; } };
    assert.equal(await ingestTransaction(client, { report_id:'r', profile_id:'456', report_type:'sdCampaigns', status, expired:false }, [], Date.now()+30000), 0);
    assert.equal(queries.at(-1), status === 'PENDING' ? 'COMMIT' : 'ROLLBACK');
  }
});

test('report validation 400 is surfaced unchanged, without automatic schema retries', async () => {
  const oldFetch = globalThis.fetch;
  const oldEnv = { id: process.env.LWA_CLIENT_ID, secret: process.env.LWA_CLIENT_SECRET, refresh: process.env.TEST_REPORT_REFRESH };
  let calls = 0;
  process.env.LWA_CLIENT_ID='test'; process.env.LWA_CLIENT_SECRET='test'; process.env.TEST_REPORT_REFRESH='test';
  globalThis.fetch = async () => {
    calls++;
    return calls === 1 ? new Response(JSON.stringify({ access_token:'fake' }), { status:200 }) :
      new Response(JSON.stringify({ detail:'configuration columns invalid; valid columns: cost, purchases, sales' }), { status:400 });
  };
  try {
    const api = await createApi({ profile_id:'456', region:'EU', env_var_name:'TEST_REPORT_REFRESH' }, Date.now()+30000);
    await assert.rejects(api('/reporting/reports', { method:'POST' }), /valid columns: cost, purchases, sales/);
    assert.equal(calls,2);
  } finally {
    globalThis.fetch=oldFetch;
    for (const [key,value] of Object.entries({ LWA_CLIENT_ID:oldEnv.id, LWA_CLIENT_SECRET:oldEnv.secret, TEST_REPORT_REFRESH:oldEnv.refresh })) {
      if (value === undefined) delete process.env[key]; else process.env[key]=value;
    }
  }
});
