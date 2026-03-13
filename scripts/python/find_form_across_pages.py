import subprocess, requests
cmd=r'''set -a; . /home/deploy/atendechat/backend/.env; set +a; PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT access_token FROM meta_connections ORDER BY id DESC LIMIT 1;"'''
utok=subprocess.check_output(['bash','-lc',cmd],text=True).strip()
form_target='1131291592353365'
acc=requests.get('https://graph.facebook.com/v23.0/me/accounts',params={'fields':'id,name,access_token','limit':200,'access_token':utok},timeout=20)
print('accounts',acc.status_code)
if acc.status_code!=200:
  print(acc.text); raise SystemExit
pages=acc.json().get('data',[])
print('pages',len(pages))
found=None
for p in pages:
  pid=p.get('id'); pt=p.get('access_token')
  if not pid or not pt: continue
  r=requests.get(f'https://graph.facebook.com/v23.0/{pid}/leadgen_forms',params={'fields':'id,name,status','limit':200,'access_token':pt},timeout=20)
  if r.status_code!=200: continue
  for f in r.json().get('data',[]):
    if f.get('id')==form_target:
      found=(p.get('name'),pid,f.get('name'))
      break
  if found: break
print('found',found)
