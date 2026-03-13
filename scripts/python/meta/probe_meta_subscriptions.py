import subprocess, requests, json
cmd=r'''set -a; . /home/deploy/atendechat/backend/.env; set +a; PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT access_token FROM meta_connections ORDER BY id DESC LIMIT 1;"'''
utok=subprocess.check_output(['bash','-lc',cmd],text=True).strip()
page='1906443612953060'
# get page token
pr=requests.get(f'https://graph.facebook.com/v23.0/{page}',params={'fields':'access_token,name','access_token':utok},timeout=20)
print('page token resp',pr.status_code,pr.text[:200])
pt=pr.json().get('access_token','') if pr.status_code==200 else ''
if not pt:
  raise SystemExit('no page token')

for endpoint in [f'https://graph.facebook.com/v23.0/{page}/subscribed_apps', f'https://graph.facebook.com/v23.0/{page}?fields=subscribed_fields']:
  r=requests.get(endpoint,params={'access_token':pt},timeout=20)
  print('\n',endpoint,r.status_code)
  print(r.text[:1200])
