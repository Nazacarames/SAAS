SELECT to_regclass('public.refresh_tokens') IS NOT NULL AS table_exists;
SELECT COUNT(*) AS total_tokens FROM refresh_tokens;
