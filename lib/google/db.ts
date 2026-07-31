import { neon } from '@neondatabase/serverless'

const EXPECTED_HOST = 'ep-holy-star-afsf5u86'

/**
 * Returns a Neon tagged-template query function bound to GOOGLE_DATABASE_URL.
 * Throws at call-time if the env var is missing or points to the wrong endpoint.
 */
export function getGoogleDb() {
  const url = process.env.GOOGLE_DATABASE_URL
  if (!url || !url.includes(EXPECTED_HOST)) {
    throw new Error(
      `GOOGLE_DATABASE_URL missing or wrong endpoint (expected host: ${EXPECTED_HOST})`
    )
  }
  return neon(url)
}
