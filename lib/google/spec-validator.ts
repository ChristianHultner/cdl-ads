// Copy-adapted from scripts/google/validate-spec.mjs.
// Keep the CLI as the command-line validation path.
// @ts-nocheck -- the validated JSON shape is intentionally runtime-defined.

export interface SpecValidationSummary {
  campaigns: number
  adGroups: number
  keywords: number
  rsas: number
  callouts: number
  structuredSnippets: number
}

export interface SpecValidationResult {
  ok: boolean
  errors: string[]
  summary: SpecValidationSummary
}

export function validateSpec(input: unknown): SpecValidationResult {
  const errors: string[] = []
  const spec = input as any

  const isObject = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const charCount = (value) => Array.from(value).length;
  const addError = (path, message) => errors.push(`${path}: ${message}`);

  function requireObject(value, path) {
    if (!isObject(value)) {
      addError(path, "must be an object");
      return false;
    }
    return true;
  }

  function requireString(value, path, { allowEmpty = false } = {}) {
    if (typeof value !== "string") {
      addError(path, "must be a string");
      return false;
    }
    if (!allowEmpty && value.trim() === "") {
      addError(path, "must not be empty");
      return false;
    }
    return true;
  }

  function requireBoolean(value, path) {
    if (typeof value !== "boolean") {
      addError(path, "must be a boolean");
      return false;
    }
    return true;
  }

  function requireNumber(value, path, { minimum = 0 } = {}) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      addError(path, "must be a finite number");
      return false;
    }
    if (value < minimum) {
      addError(path, `must be >= ${minimum}`);
      return false;
    }
    return true;
  }

  function requireStringArray(value, path, { minimum = 1 } = {}) {
    if (!Array.isArray(value)) {
      addError(path, "must be an array");
      return false;
    }
    if (value.length < minimum) {
      addError(path, `must contain at least ${minimum} item(s)`);
    }
    value.forEach((item, index) => requireString(item, `${path}[${index}]`));
    return true;
  }

  function validateRsa(rsa, path) {
    if (!requireObject(rsa, path)) return;

    if (requireStringArray(rsa.headlines, `${path}.headlines`, { minimum: 3 })) {
      rsa.headlines.forEach((headline, index) => {
        if (typeof headline === "string" && charCount(headline) > 30) {
          addError(
            `${path}.headlines[${index}]`,
            `must be <= 30 characters (received ${charCount(headline)})`,
          );
        }
      });
    }

    if (
      requireStringArray(rsa.descriptions, `${path}.descriptions`, { minimum: 2 })
    ) {
      rsa.descriptions.forEach((description, index) => {
        if (typeof description === "string" && charCount(description) > 90) {
          addError(
            `${path}.descriptions[${index}]`,
            `must be <= 90 characters (received ${charCount(description)})`,
          );
        }
      });
    }

    requireString(rsa.final_url, `${path}.final_url`, { allowEmpty: true });
  }

  const structuredSnippetHeaders = new Set([
    "Amenities",
    "Brands",
    "Courses",
    "Degree programs",
    "Destinations",
    "Featured hotels",
    "Insurance coverage",
    "Models",
    "Neighborhoods",
    "Service catalog",
    "Shows",
    "Styles",
    "Types",
  ]);

  function validateCallouts(callouts, path) {
    if (!Array.isArray(callouts)) {
      addError(path, "must be an array");
      return;
    }

    calloutCount += callouts.length;
    if (callouts.length < 2 || callouts.length > 10) {
      addError(path, "must contain 2..10 items");
    }
    callouts.forEach((callout, index) => {
      const calloutPath = `${path}[${index}]`;
      if (
        requireString(callout, calloutPath) &&
        charCount(callout) > 25
      ) {
        addError(
          calloutPath,
          `must be <= 25 characters (received ${charCount(callout)})`,
        );
      }
    });
  }

  function validateStructuredSnippets(snippets, path) {
    if (!Array.isArray(snippets)) {
      addError(path, "must be an array");
      return;
    }

    structuredSnippetCount += snippets.length;
    snippets.forEach((snippet, snippetIndex) => {
      const snippetPath = `${path}[${snippetIndex}]`;
      if (!requireObject(snippet, snippetPath)) return;

      if (
        requireString(snippet.header, `${snippetPath}.header`) &&
        !structuredSnippetHeaders.has(snippet.header)
      ) {
        addError(
          `${snippetPath}.header`,
          "must be one of Google's fixed structured snippet headers",
        );
      }

      const valuesPath = `${snippetPath}.values`;
      if (requireStringArray(snippet.values, valuesPath, { minimum: 3 })) {
        if (snippet.values.length > 10) {
          addError(valuesPath, "must contain at most 10 items");
        }
        snippet.values.forEach((value, valueIndex) => {
          if (typeof value === "string" && charCount(value) > 25) {
            addError(
              `${valuesPath}[${valueIndex}]`,
              `must be <= 25 characters (received ${charCount(value)})`,
            );
          }
        });
      }
    });
  }

  const matchTypes = new Set(["exact", "phrase", "broad"]);
  let adGroupCount = 0;
  let keywordCount = 0;
  let rsaCount = 0;
  let calloutCount = 0;
  let structuredSnippetCount = 0;

  function validateKeywords(keywords, path) {
    if (!requireObject(keywords, path)) return;

    const entries = Object.entries(keywords);
    if (entries.length === 0) {
      addError(path, "must contain at least one match type");
      return;
    }

    for (const [matchType, terms] of entries) {
      const matchPath = `${path}.${matchType}`;
      if (!matchTypes.has(matchType)) {
        addError(matchPath, "unsupported match type; use exact, phrase, or broad");
        continue;
      }
      if (!requireStringArray(terms, matchPath)) continue;

      keywordCount += terms.length;
      const seenTerms = new Set();
      terms.forEach((term, index) => {
        if (typeof term !== "string") return;
        if (term !== term.trim()) {
          addError(`${matchPath}[${index}]`, "must not have surrounding whitespace");
        }
        if (/^[\[\"]|[\]\"]$/.test(term)) {
          addError(
            `${matchPath}[${index}]`,
            "must not include match-type brackets or quotation marks",
          );
        }
        const normalized = term.toLocaleLowerCase();
        if (seenTerms.has(normalized)) {
          addError(`${matchPath}[${index}]`, "duplicate keyword in match type");
        }
        seenTerms.add(normalized);
      });
    }
  }

  if (!requireObject(spec, "spec")) {
    // The itemized root error is sufficient.
  } else {
    if (spec.schema_version !== "1") {
      addError("schema_version", 'must equal "1"');
    }

    if (!Array.isArray(spec.campaigns)) {
      addError("campaigns", "must be an array");
    } else {
      if (spec.campaigns.length < 1) {
        addError("campaigns", "must contain at least 1 campaign");
      }

      const campaignNames = new Set();
      spec.campaigns.forEach((campaign, campaignIndex) => {
        const campaignPath = `campaigns[${campaignIndex}]`;
        if (!requireObject(campaign, campaignPath)) return;

        if (requireString(campaign.name, `${campaignPath}.name`)) {
          if (campaignNames.has(campaign.name)) {
            addError(`${campaignPath}.name`, "duplicate campaign name");
          }
          campaignNames.add(campaign.name);
        }

        if (campaign.type !== "SEARCH") {
          addError(`${campaignPath}.type`, 'must equal "SEARCH"');
        }

        if (requireObject(campaign.networks, `${campaignPath}.networks`)) {
          requireBoolean(
            campaign.networks.search_partners,
            `${campaignPath}.networks.search_partners`,
          );
          requireBoolean(
            campaign.networks.display,
            `${campaignPath}.networks.display`,
          );
        }

        if (requireObject(campaign.geo, `${campaignPath}.geo`)) {
          requireString(campaign.geo.country, `${campaignPath}.geo.country`);
          requireBoolean(
            campaign.geo.presence_only,
            `${campaignPath}.geo.presence_only`,
          );
        }

        requireString(campaign.language, `${campaignPath}.language`);
        requireNumber(campaign.budget_eur_day, `${campaignPath}.budget_eur_day`, {
          minimum: 0.01,
        });

        if (requireObject(campaign.bidding, `${campaignPath}.bidding`)) {
          requireString(
            campaign.bidding.strategy,
            `${campaignPath}.bidding.strategy`,
          );
          requireNumber(
            campaign.bidding.cpc_ceiling_eur,
            `${campaignPath}.bidding.cpc_ceiling_eur`,
            { minimum: 0 },
          );
        }

        if (campaign.born_paused !== true) {
          addError(`${campaignPath}.born_paused`, "must be exactly true");
        }

        if (!Array.isArray(campaign.ad_groups)) {
          addError(`${campaignPath}.ad_groups`, "must be an array");
        } else {
          if (campaign.ad_groups.length === 0) {
            addError(`${campaignPath}.ad_groups`, "must not be empty");
          }
          const adGroupNames = new Set();
          campaign.ad_groups.forEach((adGroup, adGroupIndex) => {
            const adGroupPath = `${campaignPath}.ad_groups[${adGroupIndex}]`;
            if (!requireObject(adGroup, adGroupPath)) return;

            adGroupCount += 1;
            if (requireString(adGroup.name, `${adGroupPath}.name`)) {
              if (adGroupNames.has(adGroup.name)) {
                addError(`${adGroupPath}.name`, "duplicate ad group name in campaign");
              }
              adGroupNames.add(adGroup.name);
            }

            validateKeywords(adGroup.keywords, `${adGroupPath}.keywords`);
            if (isObject(adGroup.rsa)) rsaCount += 1;
            validateRsa(adGroup.rsa, `${adGroupPath}.rsa`);
          });
        }

        requireStringArray(campaign.negatives, `${campaignPath}.negatives`);

        if (!Array.isArray(campaign.sitelinks)) {
          addError(`${campaignPath}.sitelinks`, "must be an array");
        } else {
          if (campaign.sitelinks.length === 0) {
            addError(`${campaignPath}.sitelinks`, "must not be empty");
          }
          const sitelinkTexts = new Set();
          campaign.sitelinks.forEach((sitelink, sitelinkIndex) => {
            const sitelinkPath = `${campaignPath}.sitelinks[${sitelinkIndex}]`;
            if (!requireObject(sitelink, sitelinkPath)) return;
            if (requireString(sitelink.text, `${sitelinkPath}.text`)) {
              if (sitelinkTexts.has(sitelink.text)) {
                addError(`${sitelinkPath}.text`, "duplicate sitelink text in campaign");
              }
              sitelinkTexts.add(sitelink.text);
            }
            requireString(sitelink.final_url, `${sitelinkPath}.final_url`, {
              allowEmpty: true,
            });
          });
        }

        if (campaign.callouts !== undefined) {
          validateCallouts(campaign.callouts, `${campaignPath}.callouts`);
        }
        if (campaign.structured_snippets !== undefined) {
          validateStructuredSnippets(
            campaign.structured_snippets,
            `${campaignPath}.structured_snippets`,
          );
        }
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      campaigns: Array.isArray(spec?.campaigns) ? spec.campaigns.length : 0,
      adGroups: adGroupCount,
      keywords: keywordCount,
      rsas: rsaCount,
      callouts: calloutCount,
      structuredSnippets: structuredSnippetCount,
    },
  }
}
