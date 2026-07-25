export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'

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
    <main>
      <h1>Amazon Ads Accounts</h1>

      {credentials.map((cred) => {
        const credAccounts = adsAccounts.filter(a => a.credential_id === cred.id)
        return (
          <section
            key={cred.id}
            style={{
              marginBottom: '2rem',
              border: '1px solid #c8dfe9',
              borderRadius: '8px',
              padding: '1.25rem',
              background: 'var(--cdl-sky)',
            }}
          >
            <h2>Credential: {cred.amazon_login}</h2>

            {credAccounts.length === 0 && <p>No ads accounts for this credential.</p>}

            {credAccounts.map((acct) => {
              const acctProfiles = profiles.filter(p => p.ads_account_id === acct.ads_account_id)
              return (
                <div
                  key={acct.ads_account_id}
                  style={{
                    marginBottom: '1.5rem',
                    paddingLeft: '1rem',
                    borderLeft: '3px solid var(--cdl-blue)',
                  }}
                >
                  <h3>{acct.account_name}</h3>

                  <div className="table-card" style={{ marginBottom: '1rem' }}>
                    <table className="data-table">
                      <tbody>
                        <tr><th>Ads Account ID</th><td>{acct.ads_account_id}</td></tr>
                        <tr><th>Status</th><td>{acct.status}</td></tr>
                        <tr><th>Country Codes</th><td>{acct.country_codes.join(', ')}</td></tr>
                        <tr><th>Notes</th><td>{acct.notes ?? '—'}</td></tr>
                      </tbody>
                    </table>
                  </div>

                  <h4>Profiles ({acctProfiles.length})</h4>
                  {acctProfiles.length === 0 ? (
                    <p>No profiles linked to this ads account.</p>
                  ) : (
                    <div className="table-card">
                      <div className="table-scroll">
                        <table className="data-table">
                          <thead>
                            <tr>
                              {['Profile ID','Country','Currency','Region','Type','Entity ID','Active','Notes'].map(h => (
                                <th key={h}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {acctProfiles.map((p) => (
                              <tr key={p.profile_id}>
                                <td>{p.profile_id}</td>
                                <td>{p.country_code}</td>
                                <td>{p.currency_code}</td>
                                <td>{p.region}</td>
                                <td>{p.account_type}</td>
                                <td>{p.entity_id}</td>
                                <td>{p.is_active ? 'Yes' : 'No'}</td>
                                <td>{p.notes ?? '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
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
