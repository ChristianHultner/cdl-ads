// Display-only: aggregate each product independently; never join raw daily tables.
export const CAMPAIGN_METRICS_CTE = `WITH campaign_metrics AS (
  SELECT profile_id,campaign_id,'sponsoredProducts'::text AS campaign_type,
    sum(cost) AS spend,sum(sales_14d) AS sales,sum(purchases_14d) AS orders
  FROM amazon_campaign_daily WHERE date >= CURRENT_DATE - INTERVAL '30 days'
  GROUP BY profile_id,campaign_id
  UNION ALL
  SELECT profile_id,campaign_id,
    CASE WHEN ad_product='SD' THEN 'sponsoredDisplay' ELSE 'sponsoredBrands' END AS campaign_type,
    sum(cost) AS spend,sum(sales) AS sales,sum(purchases) AS orders
  FROM amazon_campaign_daily_other
  WHERE date >= CURRENT_DATE - INTERVAL '30 days' AND ad_product IN ('SB','SB_LEGACY','SD')
  GROUP BY profile_id,campaign_id,CASE WHEN ad_product='SD' THEN 'sponsoredDisplay' ELSE 'sponsoredBrands' END
)`

export const CAMPAIGN_LABEL_SQL = `CASE
  WHEN c.campaign_type='sponsoredDisplay' THEN 'SD'
  WHEN c.campaign_type='sponsoredBrands' THEN CASE
    WHEN c.raw->'displayAdFormats' ?| array['VIDEO','BRAND_VIDEO']
      OR c.raw->>'adFormat' IN ('VIDEO','BRAND_VIDEO') THEN 'SBV' ELSE 'SB' END
  ELSE 'SP' END`
