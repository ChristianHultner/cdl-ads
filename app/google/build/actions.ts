'use server'

import { revalidatePath } from 'next/cache'
import { buildCampaign } from '@/lib/google/campaign-builder'
import { getGoogleDb } from '@/lib/google/db'
import { SPECS, type SpecRegistryEntry } from '@/lib/google/spec-registry'

const BUILD_PATH = '/google/build'
const NO_GREEN_DRY_RUN = 'NO RECENT GREEN DRY RUN'
const CONFIRMATION_REQUIRED = 'EXECUTE CONFIRMATION REQUIRED'

function resolveBuild(specId: string, campaignName: string): SpecRegistryEntry {
  const entry = SPECS.find((candidate) => candidate.id === specId)
  if (!entry) throw new Error(`UNKNOWN SPEC ${specId}`)

  const campaigns = Array.isArray(entry.spec.campaigns)
    ? entry.spec.campaigns
    : []
  if (!campaigns.some((campaign) => campaign.name === campaignName)) {
    throw new Error(`UNKNOWN CAMPAIGN ${campaignName} IN ${entry.file}`)
  }

  return entry
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

async function finishRefusedBuild(
  id: string,
  error: string,
): Promise<void> {
  const sql = getGoogleDb()
  await sql`
    UPDATE google_build_log
       SET finished_at       = now(),
           ok                = false,
           operations        = 0,
           campaign_resource = null,
           report            = null,
           lines             = ${JSON.stringify([])}::jsonb,
           error             = ${error}
     WHERE id = ${id}
  `
  revalidatePath(BUILD_PATH)
}

async function runBuild(
  specId: string,
  campaignName: string,
  execute: boolean,
  confirmed: boolean,
): Promise<void> {
  const entry = resolveBuild(specId, campaignName)
  const sql = getGoogleDb()
  const mode = execute ? 'EXECUTE' : 'DRY_RUN'

  const [started] = (await sql`
    INSERT INTO google_build_log (mode, spec_file, campaign)
    VALUES (${mode}, ${entry.file}, ${campaignName})
    RETURNING id::text
  `) as unknown as [{ id: string }]

  if (execute) {
    const greenRows = await sql`
      SELECT 1
        FROM google_build_log
       WHERE mode = 'DRY_RUN'
         AND spec_file = ${entry.file}
         AND campaign = ${campaignName}
         AND ok = true
         AND finished_at >= now() - interval '60 minutes'
       LIMIT 1
    `

    if (greenRows.length === 0) {
      await finishRefusedBuild(started.id, NO_GREEN_DRY_RUN)
      return
    }
  }

  if (execute && !confirmed) {
    await finishRefusedBuild(started.id, CONFIRMATION_REQUIRED)
    return
  }

  try {
    const result = await buildCampaign({
      spec: entry.spec,
      campaignName,
      execute,
      log: () => {},
    })
    const report = result.report === null ? null : JSON.stringify(result.report)

    await sql`
      UPDATE google_build_log
         SET finished_at       = now(),
             ok                = ${result.ok},
             operations        = ${result.operations},
             campaign_resource = ${result.campaignResource},
             report            = ${report}::jsonb,
             lines             = ${JSON.stringify(result.lines)}::jsonb,
             error             = ${result.error}
       WHERE id = ${started.id}
    `
  } catch (error: unknown) {
    const captured = errorText(error)
    await sql`
      UPDATE google_build_log
         SET finished_at       = now(),
             ok                = false,
             operations        = 0,
             campaign_resource = null,
             report            = null,
             lines             = ${JSON.stringify(captured.split('\n'))}::jsonb,
             error             = ${captured}
       WHERE id = ${started.id}
    `
  }

  revalidatePath(BUILD_PATH)
}

export async function dryRun(
  specId: string,
  campaignName: string,
): Promise<void> {
  await runBuild(specId, campaignName, false, false)
}

export async function executeBuild(
  specId: string,
  campaignName: string,
  formData: FormData,
): Promise<void> {
  const confirmed = formData.get('confirm_execute') === 'yes'
  await runBuild(specId, campaignName, true, confirmed)
}
