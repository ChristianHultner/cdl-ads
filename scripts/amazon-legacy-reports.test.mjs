import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExactJson, legacyRows, reportJobs, requestCampaignReport, v3SbPresence, ingestTransaction, createApi, downloadLegacyReport } from '../lib/amazon/sync-runner.ts';

test('18-digit IDs survive parsing; text and metrics are not rewritten', () => {
  const rows = parseExactJson('[{"campaignId":144287439827929866,"campaignName":"text 144287439827929866","cost":2.63}]');
  assert.equal(rows[0].campaignId,'144287439827929866');
  assert.equal(rows[0].cost,2.63);
  assert.equal(rows[0].campaignName,'text 144287439827929866');
  assert.throws(() => legacyRows([{campaignId:144287439827929866,campaignName:'legacy'}],{ids:new Set(),names:new Set()},'2026-09-01'),/imprecise/);
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

test('a campaign listed in v4 but absent from same-day v3 lands; either exact ID or name skips', () => {
  const present={ids:new Set(['123']),names:new Set(['Modern'])};
  const listedInV4ButAbsentFromV3={campaignId:'144287439827929866',campaignName:'Legacy'};
  const rows=[listedInV4ButAbsentFromV3,{campaignId:'123',campaignName:'Renamed'},
    {campaignId:'456',campaignName:'Modern'},{campaignId:'789',campaignName:'modern'}];
  assert.deepEqual(legacyRows(rows,present,'2026-09-01').map(r=>r.campaignId),['144287439827929866','789']);
});

test('v3 presence is profile/day scoped; completed empty reports differ from missing coverage', async () => {
  for(const covered of [false,true]) {
    let calls=0;
    const client={async query(sql,values){
      calls++; assert.deepEqual(values,['1','2026-09-01']);
      if(sql.includes('amazon_report_requests')) {assert.match(sql,/status='INGESTED'/);return {rows:covered?[{report_id:'v3'}]:[]};}
      assert.match(sql,/ad_product='SB' AND date=\$2::date/);return {rows:[]};
    }};
    if(covered) assert.deepEqual(await v3SbPresence(client,'1','2026-09-01'),{ids:new Set(),names:new Set()});
    else {await assert.rejects(v3SbPresence(client,'1','2026-09-01'),/awaits ingested v3/);assert.equal(calls,1);}
  }
});

test('legacy replay replaces one day atomically, maps metrics, and leaves missing coverage untouched', async () => {
  const request={report_id:'x',profile_id:'1',report_type:'sbLegacyCampaigns',start_date:'2026-09-01',end_date:'2026-09-01'};
  const rows=[{campaignId:'144287439827929866',campaignName:'Legacy',cost:2,attributedConversions14d:1,attributedSales14d:10},
    {campaignId:'123',campaignName:'Modern',cost:99}];
  for(const covered of [false,true]) {
    const queries=[];
    const client={async query(sql,values){
      queries.push([sql,values]);
      if(sql.includes('FOR UPDATE')) return {rows:[{status:'INGESTED'}]};
      if(sql.includes('SELECT report_id')) return {rows:covered?[{report_id:'v3'}]:[]};
      if(sql.includes('SELECT campaign_id')) return {rows:[{id:'123',name:'Modern'}]};
      return {rows:[]};
    }};
    const work=ingestTransaction(client,request,rows,Date.now()+30000,{replayLegacy:true});
    if(!covered) {
      await assert.rejects(work,/awaits ingested v3/);assert.equal(queries.at(-1)[0],'ROLLBACK');
      assert.ok(!queries.some(([sql])=>sql.startsWith('DELETE')));continue;
    }
    assert.equal(await work,1);
    assert.deepEqual(queries.find(([sql])=>sql.startsWith('DELETE'))[1],['1','2026-09-01']);
    const values=queries.find(x=>x[0].includes('INSERT INTO amazon_campaign_daily_other'))[1];
    assert.deepEqual(values.slice(0,9),['1','SB_LEGACY','144287439827929866','2026-09-01',null,null,2,1,10]);
    assert.equal(queries.at(-1)[0],'COMMIT');
  }
});

test('a later v3 SB arrival removes overlapping legacy rows by ID or exact name', async () => {
  const queries=[];
  const client={async query(sql,values){queries.push([sql,values]);return {rows:[{status:'PENDING'}]};}};
  await ingestTransaction(client,{report_id:'v3',profile_id:'1',report_type:'sbCampaigns'},
    [{campaignId:'123',campaignName:'Modern',date:'2026-09-02',impressions:1,clicks:1,cost:1,purchases:0,sales:0}],Date.now()+30000);
  const cleanup=queries.find(([sql])=>sql.includes('DELETE FROM amazon_campaign_daily_other l'));
  assert.deepEqual(cleanup[1],['1',['2026-09-02']]);
  assert.match(cleanup[0],/s.campaign_id=l.campaign_id OR s.raw->>'campaignName'=l.raw->>'campaignName'/);
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
