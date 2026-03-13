import subprocess, requests
cmd=r'''set -a; . /home/deploy/atendechat/backend/.env; set +a; PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT access_token FROM meta_connections ORDER BY id DESC LIMIT 1;"'''
utok=subprocess.check_output(['bash','-lc',cmd],text=True).strip()
page='1906443612953060'
r=requests.get(f'https://graph.facebook.com/v23.0/{page}',params={'fields':'access_token,name','access_token':utok},timeout=20)
print(r.status_code,r.text[:500])
