import test from 'node:test';
import assert from 'node:assert/strict';
import { otherCampaignStructure, normalizeOtherCampaign } from '../lib/amazon/sync-runner.ts';
import { CAMPAIGN_METRICS_CTE } from '../lib/amazon/campaign-display.ts';

test('SB/SD structure uses paginated read-only lists, preserves IDs and flags video from creatives', async () => {
  const calls=[];
  const api=async(path,opts)=>{
    calls.push([path,opts]);
    if(path==='/sb/v4/campaigns/list') return {body:{campaigns:[{campaignId:'144287439827929866',name:'SB',state:'PAUSED',budget:5,budgetType:'DAILY'}]}};
    if(path==='/sb/v4/ads/list') return {body:JSON.parse(opts.body).nextToken
      ? {ads:[{campaignId:'144287439827929866',creative:{type:'BRAND_VIDEO'}}]}
      : {ads:[],nextToken:'page2'}};
    assert.match(path,/^\/sd\/campaigns\?startIndex=0&count=100&stateFilter=/);
    assert.equal(opts,undefined);
    return {body:[{campaignId:123,name:'SD',state:'enabled',startDate:'20200904',budget:7,budgetType:'daily'}]};
  };
  const rows=await otherCampaignStructure(api);
  assert.equal(calls.length,4);
  assert.equal(rows[0].campaignId,'144287439827929866');
  assert.deepEqual(rows[0].raw.displayAdFormats,['BRAND_VIDEO']);
  assert.equal(rows[0].type,'sponsoredBrands');
  assert.equal(rows[1].type,'sponsoredDisplay');
  assert.equal(rows[1].state,'ENABLED');
  assert.equal(rows[1].startDate,'2020-09-04');
  assert.equal(rows[1].budget,7);
});

test('malformed structure cannot silently erase budgets or round legacy IDs', () => {
  assert.throws(()=>normalizeOtherCampaign({campaignId:144287439827929866,name:'x',state:'enabled'},'sponsoredBrands',[]),/imprecise/);
  assert.throws(()=>normalizeOtherCampaign({campaignId:'1',name:'x',state:'enabled',budget:'oops'},'sponsoredDisplay',[]),/budget/);
});

test('display metrics combine SB and legacy once, keep SP/SD separate, and use the same window', () => {
  assert.match(CAMPAIGN_METRICS_CTE,/UNION ALL/);
  assert.equal((CAMPAIGN_METRICS_CTE.match(/CURRENT_DATE - INTERVAL '30 days'/g)||[]).length,2);
  assert.match(CAMPAIGN_METRICS_CTE,/ad_product IN \('SB','SB_LEGACY','SD'\)/);
  assert.match(CAMPAIGN_METRICS_CTE,/GROUP BY profile_id,campaign_id,CASE/);
  assert.doesNotMatch(CAMPAIGN_METRICS_CTE,/JOIN/);
});
