import subprocess, requests
cmd=r'''set -a; . /home/deploy/atendechat/backend/.env; set +a; PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT waba_id, phone_number_id, access_token FROM meta_connections ORDER BY id DESC LIMIT 1;"'''
row=subprocess.check_output(['bash','-lc',cmd],text=True).strip().split('|')
waba=row[0]; phone=row[1]; tok='|'.join(row[2:])
for endpoint in [f'https://graph.facebook.com/v23.0/{waba}/subscribed_apps', f'https://graph.facebook.com/v23.0/{phone}?fields=display_phone_number,verified_name,quality_rating,name_status&access_token={tok}']:
    if 'access_token=' in endpoint:
        r=requests.get(endpoint,timeout=20)
    else:
        r=requests.get(endpoint,params={'access_token':tok},timeout=20)
    print('\n',endpoint,'\n',r.status_code,r.text[:1200])
