import requests, subprocess
cmd = r'''set -a; . /home/deploy/atendechat/backend/.env; set +a; PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT id,leadgen_id,form_id FROM meta_lead_events WHERE id>=37 AND id<=42 ORDER BY id;"'''
out = subprocess.check_output(['bash','-lc',cmd], text=True)
rows = []
for line in out.strip().splitlines():
    parts = line.split('|')
    if len(parts) >= 3 and parts[1].strip():
        rows.append((int(parts[0]), parts[1].strip(), parts[2].strip()))
print('rows', rows)
base = 'http://127.0.0.1:4000/api/ai/meta-leads/webhook'
for rid, leadgen, form in rows:
    payload = {
        'companyId': 1,
        'event_id': f'repair-{rid}-{leadgen}',
        'leadgen_id': leadgen,
        'form_id': form,
        'source': 'meta_lead_ads_repair'
    }
    r = requests.post(base, json=payload, timeout=25)
    print(rid, r.status_code, r.text[:220])
