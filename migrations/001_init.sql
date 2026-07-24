CREATE TABLE amazon_credentials (
  id text PRIMARY KEY,
  amazon_login text NOT NULL,
  env_var_name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE amazon_ads_accounts (
  ads_account_id text PRIMARY KEY,
  credential_id text NOT NULL REFERENCES amazon_credentials(id),
  account_name text NOT NULL,
  status text NOT NULL,
  country_codes text[] NOT NULL,
  notes text
);

CREATE TABLE amazon_profiles (
  profile_id bigint PRIMARY KEY,
  credential_id text NOT NULL REFERENCES amazon_credentials(id),
  ads_account_id text REFERENCES amazon_ads_accounts(ads_account_id),
  country_code text NOT NULL,
  currency_code text NOT NULL,
  region text NOT NULL CHECK (region IN ('NA','EU','FE')),
  entity_id text NOT NULL,
  account_type text NOT NULL,
  marketplace_string_id text NOT NULL,
  is_active boolean NOT NULL,
  notes text
);
