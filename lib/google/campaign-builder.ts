// Copy-adapted from scripts/google/create-campaign.mjs.
// The CLI remains the command-line campaign creation path.
// @ts-nocheck -- google-ads-api response shapes are generated at runtime.

import { inspect } from 'node:util'
import { neon } from '@neondatabase/serverless'
import { GoogleAdsApi, ResourceNames, enums } from 'google-ads-api'
import { validateSpec, type SpecValidationSummary } from './spec-validator'

const EXPECTED_DB_HOST = 'ep-holy-star-afsf5u86'
const CUSTOMER_ID = '2199803274'
const US_GEO_TARGET = 'geoTargetConstants/2840'
const LANGUAGE_TARGETS = {
  en: 'languageConstants/1000',
  es: 'languageConstants/1003',
}
const MATCH_TYPES = {
  exact: enums.KeywordMatchType.EXACT,
  phrase: enums.KeywordMatchType.PHRASE,
  broad: enums.KeywordMatchType.BROAD,
}
const ENV_REQUIRED = [
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_DEVELOPER_TOKEN',
  'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_DATABASE_URL',
]

export interface BuildCampaignArgs {
  spec: unknown
  campaignName: string
  execute: boolean
  log: (line: string) => void
}

export interface CampaignBuildReport {
  campaign: string
  adGroups: number
  keywords: number
  rsas: number
  negatives: number
  sitelinks: number
  callouts: number
  snippets: number
  skipped: string[]
}

export interface BuildCampaignResult {
  ok: boolean
  operations: number
  campaignResource: string | null
  report: CampaignBuildReport | { validation: SpecValidationSummary } | null
  lines: string[]
  error: string | null
}

function fail(message: string): never {
  throw new Error(message)
}

function requireEnvironment() {
  for (const name of ENV_REQUIRED) {
    if (!process.env[name]) fail(`MISSING ${name}`)
  }

  const dbUrl = process.env.GOOGLE_DATABASE_URL
  if (!dbUrl.includes(EXPECTED_DB_HOST)) {
    fail(`WRONG DATABASE (expected host: ${EXPECTED_DB_HOST})`)
  }
}

async function guardCustomerInDatabase() {
  const sql = neon(process.env.GOOGLE_DATABASE_URL);
  const rows = await sql`
    SELECT customer_id
    FROM google_accounts
    WHERE customer_id = ${CUSTOMER_ID}
    LIMIT 1
  `;

  if (rows.length === 0) {
    fail(
      `FATAL: customer ${CUSTOMER_ID} not found in google_accounts — wrong database?`,
    );
  }
}

function gaqlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function enumName(table, value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? table[value] : String(value);
}

function sameStrings(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function assetTexts(assets) {
  if (!Array.isArray(assets)) return [];
  return assets.map((asset) => asset?.text).filter((text) => typeof text === 'string');
}

function resultResourceName(result) {
  const r = result?.mutate_operation_responses?.[0]
    ?? result?.results?.[0];
  if (!r) throw new Error('mutate returned no response entry: ' + JSON.stringify(result));
  if (r.resource_name) return r.resource_name;
  const key = Object.keys(r).find(k => k.endsWith('_result'));
  const rn = key ? r[key]?.resource_name : null;
  if (!rn) throw new Error('mutate returned no resource_name: ' + JSON.stringify(r));
  return rn;
}

function buildApiCustomer() {
  const api = new GoogleAdsApi({
    client_id: process.env.GOOGLE_ADS_CLIENT_ID,
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  });

  return api.Customer({
    customer_id: CUSTOMER_ID,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
  });
}

async function findCampaign(customer, name) {
  const rows = await customer.query(`
    SELECT
      campaign.resource_name,
      campaign.campaign_budget,
      campaign.status,
      campaign_budget.name
    FROM campaign
    WHERE campaign.name = '${gaqlString(name)}'
      AND campaign.status != REMOVED
    LIMIT 1
  `);
  return rows[0] ?? null;
}

async function findBudget(customer, name) {
  const rows = await customer.query(`
    SELECT campaign_budget.resource_name, campaign_budget.name
    FROM campaign_budget
    WHERE campaign_budget.name = '${gaqlString(name)}'
    LIMIT 1
  `);
  return rows[0]?.campaign_budget ?? null;
}

async function findLocationCriterion(customer, campaignResourceName) {
  const rows = await customer.query(`
    SELECT campaign_criterion.resource_name
    FROM campaign_criterion
    WHERE campaign_criterion.campaign = '${gaqlString(campaignResourceName)}'
      AND campaign_criterion.type = LOCATION
      AND campaign_criterion.location.geo_target_constant = '${US_GEO_TARGET}'
      AND campaign_criterion.negative = FALSE
      AND campaign_criterion.status != REMOVED
    LIMIT 1
  `);
  return rows[0]?.campaign_criterion?.resource_name ?? null;
}

async function findLanguageCriterion(
  customer,
  campaignResourceName,
  languageResourceName,
) {
  const rows = await customer.query(`
    SELECT campaign_criterion.resource_name
    FROM campaign_criterion
    WHERE campaign_criterion.campaign = '${gaqlString(campaignResourceName)}'
      AND campaign_criterion.type = LANGUAGE
      AND campaign_criterion.language.language_constant = '${languageResourceName}'
      AND campaign_criterion.negative = FALSE
      AND campaign_criterion.status != REMOVED
    LIMIT 1
  `);
  return rows[0]?.campaign_criterion?.resource_name ?? null;
}

async function findNegativeCriterion(customer, campaignResourceName, text) {
  const rows = await customer.query(`
    SELECT campaign_criterion.resource_name
    FROM campaign_criterion
    WHERE campaign_criterion.campaign = '${gaqlString(campaignResourceName)}'
      AND campaign_criterion.type = KEYWORD
      AND campaign_criterion.keyword.text = '${gaqlString(text)}'
      AND campaign_criterion.keyword.match_type = BROAD
      AND campaign_criterion.negative = TRUE
      AND campaign_criterion.status != REMOVED
    LIMIT 1
  `);
  return rows[0]?.campaign_criterion?.resource_name ?? null;
}

async function findAdGroup(customer, campaignResourceName, name) {
  const rows = await customer.query(`
    SELECT ad_group.resource_name, ad_group.status
    FROM ad_group
    WHERE ad_group.campaign = '${gaqlString(campaignResourceName)}'
      AND ad_group.name = '${gaqlString(name)}'
      AND ad_group.status != REMOVED
    LIMIT 1
  `);
  return rows[0]?.ad_group ?? null;
}

async function findKeywordCriterion(
  customer,
  adGroupResourceName,
  text,
  matchTypeName,
) {
  const rows = await customer.query(`
    SELECT ad_group_criterion.resource_name
    FROM ad_group_criterion
    WHERE ad_group_criterion.ad_group = '${gaqlString(adGroupResourceName)}'
      AND ad_group_criterion.type = KEYWORD
      AND ad_group_criterion.keyword.text = '${gaqlString(text)}'
      AND ad_group_criterion.keyword.match_type = ${matchTypeName}
      AND ad_group_criterion.negative = FALSE
      AND ad_group_criterion.status != REMOVED
    LIMIT 1
  `);
  return rows[0]?.ad_group_criterion?.resource_name ?? null;
}

async function findRsa(customer, adGroupResourceName, rsa) {
  const rows = await customer.query(`
    SELECT
      ad_group_ad.resource_name,
      ad_group_ad.ad.final_urls,
      ad_group_ad.ad.responsive_search_ad.headlines,
      ad_group_ad.ad.responsive_search_ad.descriptions
    FROM ad_group_ad
    WHERE ad_group_ad.ad_group = '${gaqlString(adGroupResourceName)}'
      AND ad_group_ad.ad.type = RESPONSIVE_SEARCH_AD
      AND ad_group_ad.status != REMOVED
  `);

  return (
    rows.find((row) => {
      const ad = row.ad_group_ad?.ad;
      return (
        sameStrings(ad?.final_urls, [rsa.final_url]) &&
        sameStrings(assetTexts(ad?.responsive_search_ad?.headlines), rsa.headlines) &&
        sameStrings(
          assetTexts(ad?.responsive_search_ad?.descriptions),
          rsa.descriptions,
        )
      );
    })?.ad_group_ad?.resource_name ?? null
  );
}

async function findSitelinkAsset(customer, sitelink) {
  const rows = await customer.query(`
    SELECT asset.resource_name, asset.final_urls, asset.sitelink_asset.link_text
    FROM asset
    WHERE asset.type = SITELINK
      AND asset.sitelink_asset.link_text = '${gaqlString(sitelink.text)}'
  `);

  return (
    rows.find((row) =>
      sameStrings(row.asset?.final_urls, [sitelink.final_url]),
    )?.asset?.resource_name ?? null
  );
}

async function findCampaignSitelink(
  customer,
  campaignResourceName,
  sitelink,
) {
  const rows = await customer.query(`
    SELECT
      campaign_asset.resource_name,
      campaign_asset.asset,
      asset.final_urls,
      asset.sitelink_asset.link_text
    FROM campaign_asset
    WHERE campaign_asset.campaign = '${gaqlString(campaignResourceName)}'
      AND campaign_asset.field_type = SITELINK
      AND asset.sitelink_asset.link_text = '${gaqlString(sitelink.text)}'
  `);

  return (
    rows.find((row) =>
      sameStrings(row.asset?.final_urls, [sitelink.final_url]),
    )?.campaign_asset ?? null
  );
}

async function findCalloutAsset(customer, calloutText) {
  const rows = await customer.query(`
    SELECT asset.resource_name, asset.callout_asset.callout_text
    FROM asset
    WHERE asset.type = CALLOUT
      AND asset.callout_asset.callout_text = '${gaqlString(calloutText)}'
    LIMIT 1
  `);

  return rows[0]?.asset?.resource_name ?? null;
}

async function findCampaignCallout(
  customer,
  campaignResourceName,
  calloutText,
) {
  const rows = await customer.query(`
    SELECT
      campaign_asset.resource_name,
      campaign_asset.asset,
      asset.callout_asset.callout_text
    FROM campaign_asset
    WHERE campaign_asset.campaign = '${gaqlString(campaignResourceName)}'
      AND campaign_asset.field_type = CALLOUT
      AND asset.callout_asset.callout_text = '${gaqlString(calloutText)}'
    LIMIT 1
  `);

  return rows[0]?.campaign_asset ?? null;
}

async function findStructuredSnippetAsset(customer, snippet) {
  const rows = await customer.query(`
    SELECT
      asset.resource_name,
      asset.structured_snippet_asset.header,
      asset.structured_snippet_asset.values
    FROM asset
    WHERE asset.type = STRUCTURED_SNIPPET
      AND asset.structured_snippet_asset.header = '${gaqlString(snippet.header)}'
  `);

  return (
    rows.find((row) =>
      sameStrings(row.asset?.structured_snippet_asset?.values, snippet.values),
    )?.asset?.resource_name ?? null
  );
}

async function findCampaignStructuredSnippet(
  customer,
  campaignResourceName,
  snippet,
) {
  const rows = await customer.query(`
    SELECT
      campaign_asset.resource_name,
      campaign_asset.asset,
      asset.structured_snippet_asset.header,
      asset.structured_snippet_asset.values
    FROM campaign_asset
    WHERE campaign_asset.campaign = '${gaqlString(campaignResourceName)}'
      AND campaign_asset.field_type = STRUCTURED_SNIPPET
      AND asset.structured_snippet_asset.header = '${gaqlString(snippet.header)}'
  `);

  return (
    rows.find((row) =>
      sameStrings(row.asset?.structured_snippet_asset?.values, snippet.values),
    )?.campaign_asset ?? null
  );
}

function createMutator(customer, execute, validationChain, log, noteOperation) {
  return async function createResource({
    entity,
    resource,
    resourceType,
    name,
    fallbackResourceName = null,
  }) {
    const operation = {
      entity,
      operation: 'create',
      resource,
    };

    noteOperation();

    if (execute) {
      const result = await customer.mutateResources([operation]);
      const resourceName = resultResourceName(result);
      log(`CREATED ${resourceType} ${resourceName}`);
      return resourceName;
    }

    validationChain.push(operation);
    log(`QUEUED ${resourceType} ${name}`);

    if (!fallbackResourceName) {
      return `${resourceType}:${name}`;
    }
    return fallbackResourceName;
  };
}

async function runCampaign({ customer, campaignSpec, execute, log, noteOperation }) {
  const validationChain = [];
  const createResource = createMutator(customer, execute, validationChain, log, noteOperation);
  const skipped = [];
  const counts = {
    adGroups: 0,
    keywords: 0,
    rsas: 0,
    negatives: 0,
    sitelinks: 0,
    callouts: 0,
    snippets: 0,
  };
  let temporaryId = -1;
  const nextTemporaryId = () => String(temporaryId--);

  const existingCampaign = await findCampaign(customer, campaignSpec.name);
  if (
    existingCampaign &&
    enumName(enums.CampaignStatus, existingCampaign.campaign.status) !== 'PAUSED'
  ) {
    fail(
      `HARD INVARIANT FAILED: existing campaign ${campaignSpec.name} is not PAUSED`,
    );
  }

  const budgetName = `${campaignSpec.name} Budget`;
  let budgetResourceName;
  if (existingCampaign?.campaign?.campaign_budget) {
    budgetResourceName = existingCampaign.campaign.campaign_budget;
    log(`EXISTS, skipping campaign_budget ${budgetName}`);
  } else {
    const existingBudget = await findBudget(customer, budgetName);
    if (existingBudget) {
      budgetResourceName = existingBudget.resource_name;
      log(`EXISTS, skipping campaign_budget ${budgetName}`);
    } else {
      const temporaryBudget = ResourceNames.campaignBudget(
        CUSTOMER_ID,
        nextTemporaryId(),
      );
      budgetResourceName = await createResource({
        entity: 'campaign_budget',
        resourceType: 'campaign_budget',
        name: budgetName,
        fallbackResourceName: temporaryBudget,
        resource: {
          resource_name: execute ? undefined : temporaryBudget,
          name: budgetName,
          explicitly_shared: false,
          amount_micros: Math.round(campaignSpec.budget_eur_day * 1_000_000),
        },
      });
    }
  }

  let campaignResourceName;
  const campaignExists = Boolean(existingCampaign);
  if (existingCampaign) {
    campaignResourceName = existingCampaign.campaign.resource_name;
    log(`EXISTS, skipping campaign ${campaignSpec.name}`);
  } else {
    const temporaryCampaign = ResourceNames.campaign(
      CUSTOMER_ID,
      nextTemporaryId(),
    );
    campaignResourceName = await createResource({
      entity: 'campaign',
      resourceType: 'campaign',
      name: campaignSpec.name,
      fallbackResourceName: temporaryCampaign,
      resource: {
        resource_name: execute ? undefined : temporaryCampaign,
        name: campaignSpec.name,
        campaign_budget: budgetResourceName,
        advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
        status: enums.CampaignStatus.PAUSED,
        contains_eu_political_advertising:
          enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
        network_settings: {
          target_google_search: true,
          target_search_network: false,
          target_content_network: false,
          target_partner_search_network: false,
        },
        target_spend: {
          cpc_bid_ceiling_micros: Math.round(
            campaignSpec.bidding.cpc_ceiling_eur * 1_000_000,
          ),
        },
        geo_target_type_setting: {
          positive_geo_target_type: enums.PositiveGeoTargetType.PRESENCE,
          negative_geo_target_type: enums.NegativeGeoTargetType.PRESENCE,
        },
      },
    });
  }

  const locationExists = campaignExists
    ? await findLocationCriterion(customer, campaignResourceName)
    : null;
  if (locationExists) {
    log('EXISTS, skipping campaign_criterion location US');
  } else {
    await createResource({
      entity: 'campaign_criterion',
      resourceType: 'campaign_criterion',
      name: 'location US',
      resource: {
        campaign: campaignResourceName,
        negative: false,
        location: {
          geo_target_constant: US_GEO_TARGET,
        },
      },
    });
  }

  const languageResourceName = LANGUAGE_TARGETS[campaignSpec.language];
  if (!languageResourceName) {
    fail(`UNSUPPORTED LANGUAGE ${campaignSpec.language}`);
  }
  const languageExists = campaignExists
    ? await findLanguageCriterion(
        customer,
        campaignResourceName,
        languageResourceName,
      )
    : null;
  if (languageExists) {
    log(
      `EXISTS, skipping campaign_criterion language ${campaignSpec.language}`,
    );
  } else {
    await createResource({
      entity: 'campaign_criterion',
      resourceType: 'campaign_criterion',
      name: `language ${campaignSpec.language}`,
      resource: {
        campaign: campaignResourceName,
        negative: false,
        language: {
          language_constant: languageResourceName,
        },
      },
    });
  }

  for (const text of campaignSpec.negatives) {
    const existingNegative = campaignExists
      ? await findNegativeCriterion(customer, campaignResourceName, text)
      : null;
    if (existingNegative) {
      log(`EXISTS, skipping campaign_criterion negative ${text}`);
    } else {
      await createResource({
        entity: 'campaign_criterion',
        resourceType: 'campaign_criterion',
        name: `negative ${text}`,
        resource: {
          campaign: campaignResourceName,
          negative: true,
          keyword: {
            text,
            match_type: enums.KeywordMatchType.BROAD,
          },
        },
      });
    }
    counts.negatives += 1;
  }

  for (const adGroupSpec of campaignSpec.ad_groups) {
    const existingAdGroup = campaignExists
      ? await findAdGroup(customer, campaignResourceName, adGroupSpec.name)
      : null;
    const adGroupExists = Boolean(existingAdGroup);
    let adGroupResourceName;

    if (existingAdGroup) {
      adGroupResourceName = existingAdGroup.resource_name;
      log(`EXISTS, skipping ad_group ${adGroupSpec.name}`);
    } else {
      const temporaryAdGroup = ResourceNames.adGroup(
        CUSTOMER_ID,
        nextTemporaryId(),
      );
      adGroupResourceName = await createResource({
        entity: 'ad_group',
        resourceType: 'ad_group',
        name: adGroupSpec.name,
        fallbackResourceName: temporaryAdGroup,
        resource: {
          resource_name: execute ? undefined : temporaryAdGroup,
          campaign: campaignResourceName,
          name: adGroupSpec.name,
          status: enums.AdGroupStatus.ENABLED,
          type: enums.AdGroupType.SEARCH_STANDARD,
        },
      });
    }
    counts.adGroups += 1;

    for (const [matchTypeKey, keywords] of Object.entries(
      adGroupSpec.keywords,
    )) {
      const matchType = MATCH_TYPES[matchTypeKey];
      const matchTypeName = matchTypeKey.toUpperCase();
      if (matchType === undefined) fail(`UNSUPPORTED MATCH TYPE ${matchTypeKey}`);

      for (const text of keywords) {
        const existingKeyword = adGroupExists
          ? await findKeywordCriterion(
              customer,
              adGroupResourceName,
              text,
              matchTypeName,
            )
          : null;
        const keywordName = `${matchTypeName} ${text}`;
        if (existingKeyword) {
          log(`EXISTS, skipping ad_group_criterion ${keywordName}`);
        } else {
          await createResource({
            entity: 'ad_group_criterion',
            resourceType: 'ad_group_criterion',
            name: keywordName,
            resource: {
              ad_group: adGroupResourceName,
              status: enums.AdGroupCriterionStatus.ENABLED,
              negative: false,
              keyword: {
                text,
                match_type: matchType,
              },
            },
          });
        }
        counts.keywords += 1;
      }
    }

    if (!adGroupSpec.rsa.final_url) {
      log(`RSA SKIPPED (no final_url): ${adGroupSpec.name}`);
      skipped.push(`rsa:${adGroupSpec.name}`);
      continue;
    }

    const existingRsa = adGroupExists
      ? await findRsa(customer, adGroupResourceName, adGroupSpec.rsa)
      : null;
    if (existingRsa) {
      log(`EXISTS, skipping ad_group_ad ${adGroupSpec.name}`);
    } else {
      await createResource({
        entity: 'ad_group_ad',
        resourceType: 'ad_group_ad',
        name: adGroupSpec.name,
        resource: {
          ad_group: adGroupResourceName,
          status: enums.AdGroupAdStatus.ENABLED,
          ad: {
            final_urls: [adGroupSpec.rsa.final_url],
            responsive_search_ad: {
              headlines: adGroupSpec.rsa.headlines.map((text) => ({ text })),
              descriptions: adGroupSpec.rsa.descriptions.map((text) => ({
                text,
              })),
            },
          },
        },
      });
    }
    counts.rsas += 1;
  }

  const sitelinksHaveEmptyUrl = campaignSpec.sitelinks.some(
    (sitelink) => !sitelink.final_url,
  );
  if (sitelinksHaveEmptyUrl) {
    log('SITELINKS SKIPPED (one or more final_url empty)');
    skipped.push('sitelinks:no_final_url');
  } else {
    for (const sitelink of campaignSpec.sitelinks) {
      const existingLink = campaignExists
        ? await findCampaignSitelink(
            customer,
            campaignResourceName,
            sitelink,
          )
        : null;
      if (existingLink) {
        log(`EXISTS, skipping sitelink ${sitelink.text}`);
        counts.sitelinks += 1;
        continue;
      }

      const existingAsset = await findSitelinkAsset(customer, sitelink);
      let assetResourceName;
      if (existingAsset) {
        assetResourceName = existingAsset;
        log(`EXISTS, skipping asset ${sitelink.text}`);
      } else {
        const temporaryAsset = ResourceNames.asset(
          CUSTOMER_ID,
          nextTemporaryId(),
        );
        assetResourceName = await createResource({
          entity: 'asset',
          resourceType: 'asset',
          name: sitelink.text,
          fallbackResourceName: temporaryAsset,
          resource: {
            resource_name: execute ? undefined : temporaryAsset,
            name: `${campaignSpec.name} | ${sitelink.text}`,
            final_urls: [sitelink.final_url],
            sitelink_asset: {
              link_text: sitelink.text,
            },
          },
        });
      }

      await createResource({
        entity: 'campaign_asset',
        resourceType: 'campaign_asset',
        name: sitelink.text,
        resource: {
          campaign: campaignResourceName,
          asset: assetResourceName,
          field_type: enums.AssetFieldType.SITELINK,
        },
      });
      counts.sitelinks += 1;
    }
  }

  for (const calloutText of campaignSpec.callouts ?? []) {
    const existingLink = campaignExists
      ? await findCampaignCallout(
          customer,
          campaignResourceName,
          calloutText,
        )
      : null;
    if (existingLink) {
      log(`EXISTS, skipping callout ${calloutText}`);
      counts.callouts += 1;
      continue;
    }

    const existingAsset = await findCalloutAsset(customer, calloutText);
    let assetResourceName;
    if (existingAsset) {
      assetResourceName = existingAsset;
      log(`EXISTS, skipping asset ${calloutText}`);
    } else {
      const temporaryAsset = ResourceNames.asset(
        CUSTOMER_ID,
        nextTemporaryId(),
      );
      assetResourceName = await createResource({
        entity: 'asset',
        resourceType: 'asset',
        name: calloutText,
        fallbackResourceName: temporaryAsset,
        resource: {
          resource_name: execute ? undefined : temporaryAsset,
          name: `${campaignSpec.name} | ${calloutText}`,
          callout_asset: {
            callout_text: calloutText,
          },
        },
      });
    }

    await createResource({
      entity: 'campaign_asset',
      resourceType: 'campaign_asset',
      name: calloutText,
      resource: {
        campaign: campaignResourceName,
        asset: assetResourceName,
        field_type: enums.AssetFieldType.CALLOUT,
      },
    });
    counts.callouts += 1;
  }

  for (const snippet of campaignSpec.structured_snippets ?? []) {
    const existingLink = campaignExists
      ? await findCampaignStructuredSnippet(
          customer,
          campaignResourceName,
          snippet,
        )
      : null;
    if (existingLink) {
      log(`EXISTS, skipping structured_snippet ${snippet.header}`);
      counts.snippets += 1;
      continue;
    }

    const existingAsset = await findStructuredSnippetAsset(customer, snippet);
    let assetResourceName;
    if (existingAsset) {
      assetResourceName = existingAsset;
      log(`EXISTS, skipping asset ${snippet.header}`);
    } else {
      const temporaryAsset = ResourceNames.asset(
        CUSTOMER_ID,
        nextTemporaryId(),
      );
      assetResourceName = await createResource({
        entity: 'asset',
        resourceType: 'asset',
        name: snippet.header,
        fallbackResourceName: temporaryAsset,
        resource: {
          resource_name: execute ? undefined : temporaryAsset,
          name: `${campaignSpec.name} | ${snippet.header}`,
          structured_snippet_asset: {
            header: snippet.header,
            values: snippet.values,
          },
        },
      });
    }

    await createResource({
      entity: 'campaign_asset',
      resourceType: 'campaign_asset',
      name: snippet.header,
      resource: {
        campaign: campaignResourceName,
        asset: assetResourceName,
        field_type: enums.AssetFieldType.STRUCTURED_SNIPPET,
      },
    });
    counts.snippets += 1;
  }

  if (!execute) {
    await customer.mutateResources(validationChain, { validate_only: true });
    log(`VALIDATE OK: ${validationChain.length} operations in one request`);
  }

  log(
    `BUILD REPORT: campaign=${campaignResourceName}` +
      ` ad_groups=${counts.adGroups}` +
      ` keywords=${counts.keywords}` +
      ` rsas=${counts.rsas}` +
      ` negatives=${counts.negatives}` +
      ` sitelinks=${counts.sitelinks}` +
      ` callouts=${counts.callouts}` +
      ` snippets=${counts.snippets}` +
      ` skipped=${skipped.length > 0 ? skipped.join(',') : 'none'}`,
  );

  return {
    campaignResource: campaignResourceName,
    report: {
      campaign: campaignResourceName,
      adGroups: counts.adGroups,
      keywords: counts.keywords,
      rsas: counts.rsas,
      negatives: counts.negatives,
      sitelinks: counts.sitelinks,
      callouts: counts.callouts,
      snippets: counts.snippets,
      skipped,
    },
  };

}

function formatError(error: unknown): string {
  const detail = inspect(error, { depth: 12, breakLength: 140 })
  const fields = Array.isArray((error as any)?.errors)
    ? (error as any).errors.flatMap((entry: any) => [
        `FIELD: ${JSON.stringify(entry?.location?.field_path_elements ?? null)}`,
        `CODE: ${JSON.stringify(entry?.error_code ?? null)} MSG: ${entry?.message}`,
      ])
    : []

  return [detail, ...fields].join('\n')
}

export async function buildCampaign({
  spec,
  campaignName,
  execute,
  log,
}: BuildCampaignArgs): Promise<BuildCampaignResult> {
  const lines: string[] = []
  const emit = (line: string) => {
    lines.push(line)
    log(line)
  }
  let operations = 0
  const noteOperation = () => {
    operations += 1
  }

  const validation = validateSpec(spec)
  if (!validation.ok) {
    emit('SPEC INVALID:')
    for (const error of validation.errors) emit(`- ${error}`)
    return {
      ok: false,
      operations,
      campaignResource: null,
      report: { validation: validation.summary },
      lines,
      error: `SPEC INVALID:\n${validation.errors.map((error) => `- ${error}`).join('\n')}`,
    }
  }

  emit(
    `SPEC VALID: ${validation.summary.campaigns} campaigns, ` +
      `${validation.summary.adGroups} ad groups, ` +
      `${validation.summary.keywords} keywords, ` +
      `${validation.summary.rsas} RSAs, ` +
      `${validation.summary.callouts} callouts, ` +
      `${validation.summary.structuredSnippets} structured snippets`,
  )

  try {
    const matches = (spec as any).campaigns.filter(
      (campaign: any) => campaign.name === campaignName,
    )
    if (matches.length !== 1) {
      fail(
        `CAMPAIGN SELECTION FAILED: expected exactly one "${campaignName}", found ${matches.length}`,
      )
    }

    const campaignSpec = matches[0]
    if (campaignSpec.born_paused !== true) {
      fail('HARD INVARIANT FAILED: born_paused must be exactly true')
    }

    const country = campaignSpec.geo?.country
    if (country !== 'US') {
      fail(
        `UNSUPPORTED COUNTRY ${country} — add an explicit geo mapping before building`,
      )
    }

    requireEnvironment()
    await guardCustomerInDatabase()

    const customer = buildApiCustomer()
    emit(execute ? 'MODE: EXECUTE' : 'MODE: VALIDATE_ONLY')
    const result = await runCampaign({
      customer,
      campaignSpec,
      execute,
      log: emit,
      noteOperation,
    })

    return {
      ok: true,
      operations,
      campaignResource: result.campaignResource,
      report: result.report,
      lines,
      error: null,
    }
  } catch (error: unknown) {
    const captured = formatError(error)
    for (const line of captured.split('\n')) emit(line)
    return {
      ok: false,
      operations,
      campaignResource: null,
      report: null,
      lines,
      error: captured,
    }
  }
}
