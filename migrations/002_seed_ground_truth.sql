INSERT INTO amazon_credentials (id, amazon_login, env_var_name) VALUES
  ('grant1','christian@cuentodeluz.com','LWA_REFRESH_TOKEN'),
  ('grant2','hultner@gmail.com','LWA_REFRESH_TOKEN_2');

INSERT INTO amazon_ads_accounts
  (ads_account_id, credential_id, account_name, status, country_codes, notes) VALUES
  ('amzn1.ads-account.g.upzm8g93hugjqs7m','grant1','Cuento de Luz','CREATED','{US,MX,CA}',NULL),
  ('amzn1.ads-account.g.s491g57y2nl02poc','grant1','Christian Hultner','CREATED','{CA,ES}','ES leg empty; CA leg is main CA'),
  ('amzn1.ads-account.g.jtyx8tq7siml8qpd','grant1','Cuento de Luz','CREATED','{GB}',NULL),
  ('amzn1.ads-account.g.gh0hsa2xtoh18uss','grant1','Cuento de Luz','CREATED','{IT,FR,DE}',NULL),
  ('amzn1.ads-account.g.d2i0hs5tjoadjbz7ll6opsk9m','grant2','Cuento de Luz','CREATED','{IT,FR,DE,GB,ES}','grant2 has rights to ES only; GB/DE/IT/FR profiles unauthorized'),
  ('amzn1.ads-account.g.db389a4mr4erbo4ae11qolv13','grant2','Cuento de Luz','CREATED','{ES}','zero campaigns; recorded for completeness');

INSERT INTO amazon_profiles
  (profile_id, credential_id, ads_account_id, country_code, currency_code, region,
   entity_id, account_type, marketplace_string_id, is_active, notes) VALUES
  (139446882235960,'grant1','amzn1.ads-account.g.upzm8g93hugjqs7m','US','USD','NA','ENTITY2Y2U945JM68YZ','vendor','ATVPDKIKX0DER',true,'>100 campaigns'),
  (395707988492653,'grant1','amzn1.ads-account.g.upzm8g93hugjqs7m','MX','MXN','NA','ENTITY1Q0QMX749261M','vendor','A1AM78C64UM0Y8',true,'20 campaigns'),
  (1068790837798301,'grant1','amzn1.ads-account.g.upzm8g93hugjqs7m','CA','CAD','NA','ENTITY1J6G1987067B9','vendor','A2EUQ1WTGCTBG2',true,'CA-second, 3 campaigns'),
  (350599867165328,'grant1','amzn1.ads-account.g.s491g57y2nl02poc','CA','CAD','NA','ENTITY2Z30EZDC96CJW','vendor','A2EUQ1WTGCTBG2',true,'main CA, 20 campaigns'),
  (1711934819800765,'grant1','amzn1.ads-account.g.jtyx8tq7siml8qpd','UK','GBP','EU','ENTITY3UUQNX33ME5L6','vendor','A1F83G8C2ARO7P',true,'28 campaigns'),
  (3035560362970447,'grant1','amzn1.ads-account.g.gh0hsa2xtoh18uss','FR','EUR','EU','ENTITY11I4VJ3DCJN5O','vendor','A13V1IB3VIYZZH',true,'5 campaigns'),
  (2213278747143677,'grant1','amzn1.ads-account.g.gh0hsa2xtoh18uss','DE','EUR','EU','ENTITY2CXN85QS1MZ34','vendor','A1PA6795UKMFR9',true,'5 campaigns'),
  (2286455750996728,'grant1','amzn1.ads-account.g.gh0hsa2xtoh18uss','IT','EUR','EU','ENTITY26WIBLM8QR9HK','vendor','APJ6JRA9NG5V4',true,'3 campaigns'),
  (2263723137827296,'grant2','amzn1.ads-account.g.d2i0hs5tjoadjbz7ll6opsk9m','ES','EUR','EU','ENTITYLRY5XMVPNYC1','vendor','A1RKKUPIHCS9HS',true,'live ES, >100 campaigns');
