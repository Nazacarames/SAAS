UPDATE runtime_settings
SET value = 'ac837baf1c7246e6376fac174001560a', updated_at = NOW()
WHERE key = 'waCloudAppSecret' AND company_id = 1;

INSERT INTO runtime_settings (company_id, key, value, created_at, updated_at)
SELECT 1, 'waCloudAppSecret', 'ac837baf1c7246e6376fac174001560a', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM runtime_settings WHERE company_id = 1 AND key = 'waCloudAppSecret'
);
