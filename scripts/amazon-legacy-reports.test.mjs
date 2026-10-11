import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExactJson, legacyRows, reportJobs, requestCampaignReport, listCurrentSbCampaigns, ingestTransaction, createApi, downloadLegacyReport } from '../lib/amazon/sync-runner.ts';

test('18-digit IDs survive parsing; text and metrics are not rewritten', () => {
  const rows = parseExactJson('[{"campaignId":144287439827929866,"campaignName":"text 144287439827929866","cost":2.63}]');
  assert.equal(rows[0].campaignId,'144287439827929866');
  assert.equal(rows[0].cost,2.63);
  assert.equal(rows[0].campaignName,'text 144287439827929866');
  assert.throws(() => legacyRows([{campaignId:144287439827929866}],new Set(),'2026-09-01'),/imprecise/);
});

test('seven daily v2 requests coexist with five unchanged v3 windows', async () => {
  const jobs = reportJobs('2026-10-04','2026-10-10');
  assert.equal(jobs.length,12);
  const legacy = jobs.filter(j=>j.type==='sbLegacyCampaigns');
  assert.equal(legacy.length,7);
  const calls=[];
  for (const j of legacy) await requestCampaignReport(async (path,opts)=>{calls.push([path,JSON.parse(opts.body)]);},j.type,j.startDate,j.endDate);
  assert.deepEqual(calls.map(x=>x[1].reportDate),['20261004','20261005','20261006','20261007','20261008','20261009','20261010']);
  assert.ok(calls.every(x=>x[0]==='/v2/hsa/campaigns/report'&&x[1].creativeType==='all'));
});

test('legacy exclusion uses all pages and all v4 campaign states; malformed lists fail closed', async () => {
  let calls=0;
  const ids=await listCurrentSbCampaigns(async(path,opts)=>{
    const body=JSON.parse(opts.body);
    assert.deepEqual(body.stateFilter.include,['ENABLED','PAUSED','ARCHIVED']);
    calls++;
    return {body:calls===1?{campaigns:[{campaignId:'123'}],nextToken:'next'}:{campaigns:[{campaignId:'456'}]}};
  });
  assert.equal(calls,2);
  assert.deepEqual(legacyRows([{campaignId:'123'},{campaignId:'456'},{campaignId:'144287439827929866'}],ids,'2026-09-01').map(r=>r.campaignId),['144287439827929866']);
  await assert.rejects(listCurrentSbCampaigns(async()=>({body:{}})),/blocked/);
});

test('legacy landing requires a complete filter, maps metrics and preserves unknown counters', async () => {
  const request={report_id:'x',profile_id:'1',report_type:'sbLegacyCampaigns',start_date:'2026-09-01',end_date:'2026-09-01'};
  const rows=[{campaignId:'144287439827929866',cost:2,attributedConversions14d:1,attributedSales14d:10},{campaignId:'123',cost:99}];
  const queries=[];
  const client={async query(sql,values){queries.push([sql,values]);return {rows:[{status:'PENDING'}]};}};
  await assert.rejects(ingestTransaction(client,request,rows,Date.now()+30000),/complete SB v4 list/);
  assert.equal(queries.length,0);
  assert.equal(await ingestTransaction(client,request,rows,Date.now()+30000,new Set(['123'])),1);
  const values=queries.find(x=>x[0].includes('INSERT INTO amazon_campaign_daily_other'))[1];
  assert.deepEqual(values.slice(0,9),['1','SB_LEGACY','144287439827929866','2026-09-01',null,null,2,1,10]);
  assert.equal(queries.at(-1)[0],'COMMIT');
});

test('legacy download sends credentials only to Amazon API, not redirected storage', async () => {
  const original=globalThis.fetch;
  const saved={LWA_CLIENT_ID:process.env.LWA_CLIENT_ID,LWA_CLIENT_SECRET:process.env.LWA_CLIENT_SECRET,TEST_LEGACY_REFRESH:process.env.TEST_LEGACY_REFRESH};
  Object.assign(process.env,{LWA_CLIENT_ID:'test',LWA_CLIENT_SECRET:'test',TEST_LEGACY_REFRESH:'test'});
  globalThis.fetch=async(url,opts)=>{
    if (String(url).includes('/auth/o2/')) return new Response('{"access_token":"fake"}');
    if (String(url).includes('/v2/reports/')) {
      assert.equal(opts.redirect,'manual'); assert.ok(opts.headers.Authorization);
      return new Response(null,{status:307,headers:{location:'https://storage.example/report'}});
    }
    assert.equal(opts.headers,undefined);
    return new Response('[{"campaignId":144287439827929866,"cost":1}]');
  };
  try {
    const api=await createApi({profile_id:'1',region:'EU',env_var_name:'TEST_LEGACY_REFRESH'},Date.now()+30000);
    assert.equal((await downloadLegacyReport(api,'id'))[0].campaignId,'144287439827929866');
  } finally {
    globalThis.fetch=original;
    for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});
