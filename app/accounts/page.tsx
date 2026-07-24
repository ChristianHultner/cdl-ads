export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'

const cell: React.CSSProperties = { border: '1px solid #ccc', padding: '4px 8px' }
const headCell: React.CSSProperties = { ...cell, background: '#f0f0f0', textAlign: 'left' }

interface Credential { id: string; amazon_login: string }
interface AdsAccount {
  ads_account_id: string; credential_id: string; account_name: string
  status: string; country_codes: string[]; notes: string | null
}
interface Profile {
  profile_id: string; ads_account_id: string | null; country_code: string
  currency_code: string; region: string; account_type: string
  entity_id: string; is_active: boolean; notes: string | null
}

export default async function AccountsPage() {
  const sql = neon(process.env.DATABASE_URL!)

  const [credentials, adsAccounts, profiles] = (await Promise.all([
    sql`SELECT id, amazon_login FROM amazon_credentials ORDER BY amazon_login`,
    sql`SELECT ads_account_id, credential_id, account_name, status, country_codes, notes
        FROM amazon_ads_accounts ORDER BY account_name`,
    sql`SELECT profile_id::text, ads_account_id, country_code, currency_code, region,
               account_type, entity_id, is_active, notes
        FROM amazon_profiles ORDER BY profile_id`,
  ])) as unknown as [Credential[], AdsAccount[], Profile[]]

  return (
    <main style={{ fontFamily: 'monospace', padding: '2rem', maxWidth: '1200px', margin: '0 auto' }}>
      <nav style={{ marginBottom: '1.5rem' }}>
        <a href="/">← Home</a>
      </nav>
      <h1 style={{ marginTop: 0 }}>Amazon Ads Accounts</h1>

      {credentials.map((cred) => {
        const credAccounts = adsAccounts.filter(a => a.credential_id === cred.id)
        return (
          <section key={cred.id} style={{ marginBottom: '2rem', border: '1px solid #999', padding: '1rem' }}>
            <h2 style={{ marginTop: 0 }}>Credential: {cred.amazon_login}</h2>

            {credAccounts.length === 0 && <p>No ads accounts for this credential.</p>}

            {credAccounts.map((acct) => {
              const acctProfiles = profiles.filter(p => p.ads_account_id === acct.ads_account_id)
              return (
                <div key={acct.ads_account_id} style={{ marginBottom: '1.5rem', paddingLeft: '1rem', borderLeft: '3px solid #bbb' }}>
                  <h3 style={{ marginTop: 0 }}>{acct.account_name}</h3>

                  <table style={{ borderCollapse: 'collapse', marginBottom: '1rem' }}>
                    <tbody>
                      <tr><th style={headCell}>Ads Account ID</th><td style={cell}>{acct.ads_account_id}</td></tr>
                      <tr><th style={headCell}>Status</th><td style={cell}>{acct.status}</td></tr>
                      <tr><th style={headCell}>Country Codes</th><td style={cell}>{acct.country_codes.join(', ')}</td></tr>
                      <tr><th style={headCell}>Notes</th><td style={cell}>{acct.notes ?? '—'}</td></tr>
                    </tbody>
                  </table>

                  <h4 style={{ marginBottom: '0.4rem' }}>Profiles ({acctProfiles.length})</h4>
                  {acctProfiles.length === 0 ? (
                    <p>No profiles linked to this ads account.</p>
                  ) : (
                    <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                      <thead>
                        <tr>
                          {['Profile ID','Country','Currency','Region','Type','Entity ID','Active','Notes'].map(h => (
                            <th key={h} style={headCell}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {acctProfiles.map((p) => (
                          <tr key={p.profile_id}>
                            <td style={cell}>{p.profile_id}</td>
                            <td style={cell}>{p.country_code}</td>
                            <td style={cell}>{p.currency_code}</td>
                            <td style={cell}>{p.region}</td>
                            <td style={cell}>{p.account_type}</td>
                            <td style={cell}>{p.entity_id}</td>
                            <td style={cell}>{p.is_active ? 'Yes' : 'No'}</td>
                            <td style={cell}>{p.notes ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )
            })}
          </section>
        )
      })}
    </main>
  )
}
