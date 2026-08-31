// Reject open recommendations whose existing destination is no longer ENABLED.
// Usage: node --env-file=.env.local scripts/reject-stale-recommendations.mjs [--dry-run]
import { Pool, neonConfig } from '@neondatabase/serverless';

neonConfig.webSocketConstructor = WebSocket;

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');

const dryRun = process.argv.slice(2).includes('--dry-run');
const pool = new Pool({ connectionString: DATABASE_URL });

const destinationCte = `
  WITH destinations AS (
    SELECT
      r.id,
      r.rec_type,
      r.target_text,
      r.profile_id,
      COALESCE(
        r.campaign_id,
        r.evidence #>> '{resolved_destination,campaign_id}',
        r.evidence ->> 'campaign_id',
        r.evidence #>> '{primary_placement,campaign_id}'
      ) AS destination_campaign_id,
      COALESCE(
        r.evidence #>> '{resolved_destination,ad_group_id}',
        r.evidence ->> 'ad_group_id',
        r.evidence #>> '{primary_placement,ad_group_id}'
      ) AS destination_ad_group_id
    FROM recommendations r
    WHERE r.status IN ('DRAFT', 'APPROVED')
      AND r.rec_type <> 'CREATE_STRUCTURE'
  ),
  stale AS (
    SELECT
      d.id,
      d.rec_type,
      d.target_text,
      c.name AS campaign_name,
      COALESCE(c.state, 'MISSING') AS campaign_state,
      CASE
        WHEN d.destination_ad_group_id IS NULL THEN NULL
        ELSE COALESCE(ag.state, 'MISSING')
      END AS ad_group_state
    FROM destinations d
    LEFT JOIN amazon_campaigns c
      ON c.profile_id = d.profile_id
     AND c.campaign_id = d.destination_campaign_id
    LEFT JOIN amazon_ad_groups ag
      ON ag.profile_id = d.profile_id
     AND ag.ad_group_id = d.destination_ad_group_id
     AND ag.campaign_id = d.destination_campaign_id
    WHERE c.state IS DISTINCT FROM 'ENABLED'
       OR (d.destination_ad_group_id IS NOT NULL AND ag.state IS DISTINCT FROM 'ENABLED')
  )`;

let rows;
if (dryRun) {
  ({ rows } = await pool.query(
    `${destinationCte}
     SELECT id, rec_type, target_text, campaign_name, campaign_state, ad_group_state
       FROM stale
      ORDER BY id`,
  ));
} else {
  ({ rows } = await pool.query(
    `${destinationCte},
     rejected AS (
       UPDATE recommendations r
          SET status   = 'REJECTED',
              ruled_at = now(),
              evidence = r.evidence || jsonb_build_object(
                'reject_reason', 'destination_not_enabled'
              )
         FROM stale s
        WHERE r.id = s.id
          AND r.status IN ('DRAFT', 'APPROVED')
       RETURNING r.id, r.ruled_at
     )
     SELECT
       s.id,
       s.rec_type,
       s.target_text,
       s.campaign_name,
       s.campaign_state,
       s.ad_group_state,
       rejected.ruled_at
     FROM stale s
     JOIN rejected USING (id)
     ORDER BY s.id`,
  ));
}

console.log(
  `destination-staleness-sweep mode=${dryRun ? 'dry-run' : 'live'} ` +
  `${dryRun ? 'would_reject' : 'rejected'}=${rows.length}`,
);
for (const row of rows) {
  console.log(
    `id=${row.id} rec_type=${row.rec_type} target=${JSON.stringify(row.target_text)} ` +
    `campaign=${JSON.stringify(row.campaign_name)} campaign_state=${row.campaign_state} ` +
    `ad_group_state=${row.ad_group_state ?? 'none'}` +
    (row.ruled_at ? ` ruled_at=${new Date(row.ruled_at).toISOString()}` : ''),
  );
}
console.log(`rec_ids=${rows.map((row) => row.id).join(',') || 'none'}`);

await pool.end();
