import subprocess, requests
app_id='1411059550398601'
cmd=r'''set -a; . /home/deploy/atendechat/backend/.env; set +a; PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT access_token FROM meta_connections ORDER BY id DESC LIMIT 1;"'''
tok=subprocess.check_output(['bash','-lc',cmd],text=True).strip()
for method in ['get']:
    r=requests.get(f'https://graph.facebook.com/v23.0/{app_id}/subscriptions',params={'access_token':tok},timeout=20)
    print(r.status_code,r.text[:1200])
