import subprocess, requests, json
cmd=r'''set -a; . /home/deploy/atendechat/backend/.env; set +a; PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT access_token FROM meta_connections ORDER BY id DESC LIMIT 1;"'''
utok=subprocess.check_output(['bash','-lc',cmd],text=True).strip()
page='1906443612953060'
pt=requests.get(f'https://graph.facebook.com/v23.0/{page}',params={'fields':'access_token','access_token':utok},timeout=20).json().get('access_token','')
r=requests.get(f'https://graph.facebook.com/v23.0/{page}/leadgen_forms',params={'fields':'id,name,status','limit':500,'access_token':pt},timeout=20)
print(r.status_code)
print(r.text[:1200])
if r.status_code==200:
 d=r.json().get('data',[])
 print('count',len(d))
 print([x for x in d if x.get('id')=='1131291592353365'])
