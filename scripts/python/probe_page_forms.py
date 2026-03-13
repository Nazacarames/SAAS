import subprocess, requests
cmd=r'''set -a; . /home/deploy/atendechat/backend/.env; set +a; PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT access_token FROM meta_connections ORDER BY id DESC LIMIT 1;"'''
tok=subprocess.check_output(['bash','-lc',cmd],text=True).strip()
page='1906443612953060'
r=requests.get(f'https://graph.facebook.com/v23.0/{page}/leadgen_forms',params={'fields':'id,name,status','limit':200,'access_token':tok},timeout=20)
print(r.status_code)
print(r.text[:800])
