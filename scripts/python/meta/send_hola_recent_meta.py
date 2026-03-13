import requests, subprocess

base='http://127.0.0.1:4000'
login=requests.post(base+'/api/auth/login',json={'email':'admin@atendechat.com','password':'admin123'},timeout=10)
login.raise_for_status()
token=login.json()['token']
H={'Authorization':f'Bearer {token}','Content-Type':'application/json'}

cmd=r'''set -a; . /home/deploy/atendechat/backend/.env; set +a; PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT DISTINCT NULLIF(REGEXP_REPLACE(COALESCE(contact_phone,''),'\\D','','g'),'') AS phone, COALESCE(NULLIF(contact_name,''),'amigo') FROM meta_lead_events WHERE created_at >= NOW() - INTERVAL '24 hours' AND COALESCE(leadgen_id,'')<>'' ORDER BY phone DESC;"'''
out=subprocess.check_output(['bash','-lc',cmd],text=True)
rows=[]
for line in out.splitlines():
    if '|' in line:
        p,n=line.split('|',1)
        p=p.strip(); n=n.strip().split(' ')[0] if n.strip() else 'amigo'
        if p: rows.append((p,n))
print('targets',rows)

for p,n in rows:
    payload={'to':p,'templateName':'hola','languageCode':'es_AR','templateVariables':[n],'idempotencyKey':f'fix-hola-{p}'}
    r=requests.post(base+'/api/ai/meta/oauth/test-send',headers=H,json=payload,timeout=20)
    print(p,r.status_code,r.text[:220])
