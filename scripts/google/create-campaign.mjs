#!/usr/bin/env node

/**
 * Build one Google Ads Search campaign from a validated campaign spec.
 *
 * Default mode is validate-only. Pass --execute for real creates.
 * The campaign is always created PAUSED; ad groups and ads may be enabled
 * because the campaign-level pause is the governing safety boundary.
 */

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';
import {
  GoogleAdsApi,
  ResourceNames,
  enums,
} from 'google-ads-api';

const EXPECTED_DB_HOST = 'ep-holy-star-afsf5u86';
const CUSTOMER_ID = '2199803274';
const US_GEO_TARGET = 'geoTargetConstants/2840';
const LANGUAGE_TARGETS = {
  en: 'languageConstants/1000',
  es: 'languageConstants/1003',
};
const MATCH_TYPES = {
  exact: enums.KeywordMatchType.EXACT,
  phrase: enums.KeywordMatchType.PHRASE,
  broad: enums.KeywordMatchType.BROAD,
};
const ENV_REQUIRED = [
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_DEVELOPER_TOKEN',
  'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_ADS_CUSTOMER_ID',
  'GOOGLE_DATABASE_URL',
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {
    specPath: null,
    campaignName: null,
    execute: false,
  };

  for (const arg of argv) {
    if (arg.startsWith('--spec=')) {
      if (parsed.specPath !== null) fail('DUPLICATE --spec');
      parsed.specPath = arg.slice('--spec='.length);
    } else if (arg.startsWith('--campaign=')) {
      if (parsed.campaignName !== null) fail('DUPLICATE --campaign');
      parsed.campaignName = arg.slice('--campaign='.length);
    } else if (arg === '--execute') {
      parsed.execute = true;
    } else {
      fail(`UNKNOWN ARGUMENT ${arg}`);
    }
  }

  if (!parsed.specPath) fail('MISSING --spec=<path>');
  if (!parsed.campaignName) fail('MISSING --campaign=<name>');
  return parsed;
}

function runSpecValidator(specPath) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const validatorPath = resolve(scriptDir, 'validate-spec.mjs');
  const result = spawnSync(process.execPath, [validatorPath, specPath], {
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`SPEC VALIDATION FAILED (exit ${result.status ?? 'unknown'})`);
  }
}

function requireEnvironment() {
  for (const name of ENV_REQUIRED) {
    if (!process.env[name]) fail(`MISSING ${name}`);
  }

  const dbUrl = process.env.GOOGLE_DATABASE_URL;
  if (!dbUrl.includes(EXPECTED_DB_HOST)) {
    fail(`WRONG DATABASE (expected host: ${EXPECTED_DB_HOST})`);
  }
  if (process.env.GOOGLE_ADS_CUSTOMER_ID !== CUSTOMER_ID) {
    fail(
      `UNEXPECTED CUSTOMER ID (got ${process.env.GOOGLE_ADS_CUSTOMER_ID}, want ${CUSTOMER_ID})`,
    );
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
  const resourceName = result?.results?.[0]?.resource_name;
  if (!resourceName) throw new Error('Google Ads mutate returned no resource_name');
  return resourceName;
}

function buildApiCustomer() {
  const api = new GoogleAdsApi({
    client_id: process.env.GOOGLE_ADS_CLIENT_ID,
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  });

  return api.Customer({
    customer_id: process.env.GOOGLE_ADS_CUSTOMER_ID,
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

function createMutator(customer, execute) {
  const validationChain = [];

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

    if (execute) {
      const result = await customer.mutateResources([operation]);
      const resourceName = resultResourceName(result);
      console.log(`CREATED ${resourceType} ${resourceName}`);
      return resourceName;
    }

    validationChain.push(operation);
    await customer.mutateResources([...validationChain], {
      validate_only: true,
    });
    console.log(`VALIDATE OK ${resourceType} ${name}`);

    if (!fallbackResourceName) {
      return `${resourceType}:${name}`;
    }
    return fallbackResourceName;
  };
}

async function buildCampaign({ customer, campaignSpec, execute }) {
  const createResource = createMutator(customer, execute);
  const skipped = [];
  const counts = {
    adGroups: 0,
    keywords: 0,
    rsas: 0,
    negatives: 0,
    sitelinks: 0,
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
    console.log(`EXISTS, skipping campaign_budget ${budgetName}`);
  } else {
    const existingBudget = await findBudget(customer, budgetName);
    if (existingBudget) {
      budgetResourceName = existingBudget.resource_name;
      console.log(`EXISTS, skipping campaign_budget ${budgetName}`);
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
    console.log(`EXISTS, skipping campaign ${campaignSpec.name}`);
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
    console.log('EXISTS, skipping campaign_criterion location US');
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
    console.log(
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
      console.log(`EXISTS, skipping campaign_criterion negative ${text}`);
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
      console.log(`EXISTS, skipping ad_group ${adGroupSpec.name}`);
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
          console.log(`EXISTS, skipping ad_group_criterion ${keywordName}`);
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
      console.warn(`RSA SKIPPED (no final_url): ${adGroupSpec.name}`);
      skipped.push(`rsa:${adGroupSpec.name}`);
      continue;
    }

    const existingRsa = adGroupExists
      ? await findRsa(customer, adGroupResourceName, adGroupSpec.rsa)
      : null;
    if (existingRsa) {
      console.log(`EXISTS, skipping ad_group_ad ${adGroupSpec.name}`);
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
    console.warn('SITELINKS SKIPPED (one or more final_url empty)');
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
        console.log(`EXISTS, skipping sitelink ${sitelink.text}`);
        counts.sitelinks += 1;
        continue;
      }

      const existingAsset = await findSitelinkAsset(customer, sitelink);
      let assetResourceName;
      if (existingAsset) {
        assetResourceName = existingAsset;
        console.log(`EXISTS, skipping asset ${sitelink.text}`);
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

  console.log(
    `BUILD REPORT: campaign=${campaignResourceName}` +
      ` ad_groups=${counts.adGroups}` +
      ` keywords=${counts.keywords}` +
      ` rsas=${counts.rsas}` +
      ` negatives=${counts.negatives}` +
      ` sitelinks=${counts.sitelinks}` +
      ` skipped=${skipped.length > 0 ? skipped.join(',') : 'none'}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const specPath = resolve(process.cwd(), args.specPath);

  runSpecValidator(specPath);
  const spec = JSON.parse(await readFile(specPath, 'utf8'));
  const matches = spec.campaigns.filter(
    (campaign) => campaign.name === args.campaignName,
  );
  if (matches.length !== 1) {
    fail(
      `CAMPAIGN SELECTION FAILED: expected exactly one "${args.campaignName}", found ${matches.length}`,
    );
  }

  const campaignSpec = matches[0];
  if (campaignSpec.born_paused !== true) {
    fail('HARD INVARIANT FAILED: born_paused must be exactly true');
  }

  requireEnvironment();
  await guardCustomerInDatabase();

  const customer = buildApiCustomer();
  console.log(args.execute ? 'MODE: EXECUTE' : 'MODE: VALIDATE_ONLY');
  await buildCampaign({
    customer,
    campaignSpec,
    execute: args.execute,
  });
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
