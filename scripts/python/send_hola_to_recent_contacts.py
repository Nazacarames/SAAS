import requests, subprocess

base='http://127.0.0.1:4000'
login=requests.post(base+'/api/auth/login',json={'email':'admin@atendechat.com','password':'admin123'},timeout=10)
login.raise_for_status()
t=login.json()['token']
H={'Authorization':f'Bearer {t}','Content-Type':'application/json'}

cmd=r'''set -a; . /home/deploy/atendechat/backend/.env; set +a; PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT c.id, c.name FROM contacts c JOIN tickets t ON t.\"contactId\"=c.id AND t.\"companyId\"=c.\"companyId\" LEFT JOIN messages m ON m.\"ticketId\"=t.id WHERE c.\"companyId\"=1 AND c.source IN ('ECOPUEBLO','Paseo del norte-copy','CANNES','CIUDAD INDUSTRIA JULIO') AND c.\"updatedAt\" >= NOW() - INTERVAL '24 hours' GROUP BY c.id,c.name HAVING COUNT(m.id)=0 ORDER BY c.id DESC LIMIT 20;"'''
out=subprocess.check_output(['bash','-lc',cmd],text=True)
rows=[]
for line in out.splitlines():
    if '|' in line:
        cid,name=line.split('|',1)
        rows.append((int(cid),name.strip()))
print('targets',rows)

for cid,name in rows:
    payload={
      'templateName':'hola',
      'languageCode':'es_AR',
      'templateVariables':[name.split(' ')[0]]
    }
    r=requests.post(f'{base}/api/contacts/{cid}/message',headers=H,json=payload,timeout=25)
    print(cid,r.status_code,r.text[:220])
