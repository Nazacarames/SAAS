#!/usr/bin/env bash
set -euo pipefail
set -a
. /home/deploy/atendechat/backend/.env
set +a

SQL="
WITH src AS (
  SELECT
    id,
    NULLIF(COALESCE(payload_json, '')::jsonb #>> '{entry,0,changes,0,value,leadgen_id}', '') AS p_leadgen,
    NULLIF(COALESCE(payload_json, '')::jsonb #>> '{entry,0,changes,0,value,page_id}', '') AS p_page,
    NULLIF(COALESCE(payload_json, '')::jsonb #>> '{entry,0,changes,0,value,form_id}', '') AS p_form,
    NULLIF(COALESCE(payload_json, '')::jsonb #>> '{entry,0,changes,0,value,ad_id}', '') AS p_ad,
    NULLIF(COALESCE(payload_json, '')::jsonb #>> '{entry,0,changes,0,value,campaign_id}', '') AS p_campaign,
    NULLIF(COALESCE(payload_json, '')::jsonb #>> '{entry,0,changes,0,value,adgroup_id}', '') AS p_adset
  FROM meta_lead_events
  WHERE COALESCE(leadgen_id,'') = ''
)
UPDATE meta_lead_events m
SET
  leadgen_id = COALESCE(src.p_leadgen, m.leadgen_id),
  page_id = COALESCE(NULLIF(m.page_id,''), src.p_page, m.page_id),
  form_id = COALESCE(NULLIF(m.form_id,''), src.p_form, m.form_id),
  ad_id = COALESCE(NULLIF(m.ad_id,''), src.p_ad, m.ad_id),
  campaign_id = COALESCE(NULLIF(m.campaign_id,''), src.p_campaign, m.campaign_id),
  adset_id = COALESCE(NULLIF(m.adset_id,''), src.p_adset, m.adset_id),
  updated_at = NOW()
FROM src
WHERE m.id = src.id AND src.p_leadgen IS NOT NULL;
"

PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "$SQL"
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT COUNT(*) FROM meta_lead_events WHERE COALESCE(leadgen_id,'')='';"
