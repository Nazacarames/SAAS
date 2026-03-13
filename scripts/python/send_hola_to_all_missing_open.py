import requests, subprocess

base='http://127.0.0.1:4000'
login=requests.post(base+'/api/auth/login',json={'email':'admin@atendechat.com','password':'admin123'},timeout=15)
login.raise_for_status()
token=login.json()['token']
H={'Authorization':f'Bearer {token}','Content-Type':'application/json'}

# Phones from meta leads that still have no outbound message in their ticket thread.
cmd=r'''set -a; . /home/deploy/atendechat/backend/.env; set +a; PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Atc "WITH meta AS (SELECT DISTINCT NULLIF(REGEXP_REPLACE(COALESCE(ev.contact_phone,''),'\\D','','g'),'') AS phone, MAX(COALESCE(ev.contact_name,'')) AS name FROM meta_lead_events ev WHERE COALESCE(ev.leadgen_id,'')<>'' AND ev.created_at >= NOW() - INTERVAL '14 days' GROUP BY NULLIF(REGEXP_REPLACE(COALESCE(ev.contact_phone,''),'\\D','','g'),'') ), linked AS (SELECT m.phone, m.name, c.id AS contact_id FROM meta m LEFT JOIN contacts c ON NULLIF(REGEXP_REPLACE(COALESCE(c.number,''),'\\D','','g'),'') = m.phone WHERE m.phone IS NOT NULL ), pending AS (SELECT l.phone, l.name, l.contact_id, t.id AS ticket_id FROM linked l LEFT JOIN tickets t ON t.\"contactId\" = l.contact_id AND t.status IN ('open','pending') ), with_msgs AS (SELECT p.phone, p.name, p.contact_id, p.ticket_id, SUM(CASE WHEN m.id IS NOT NULL THEN 1 ELSE 0 END) AS msg_count FROM pending p LEFT JOIN messages m ON m.\"ticketId\" = p.ticket_id GROUP BY p.phone,p.name,p.contact_id,p.ticket_id) SELECT phone, COALESCE(NULLIF(name,''),'amigo') FROM with_msgs WHERE COALESCE(msg_count,0)=0 ORDER BY phone DESC;"'''
out=subprocess.check_output(['bash','-lc',cmd],text=True)
rows=[]
for line in out.splitlines():
    if '|' in line:
        phone,name=line.split('|',1)
        phone=phone.strip()
        first=(name.strip().split(' ')[0] if name.strip() else 'amigo')
        if phone: rows.append((phone,first))

print('targets_count',len(rows))
for phone,first in rows:
    payload={
      'to':phone,
      'templateName':'hola',
      'languageCode':'es_AR',
      'templateVariables':[first],
      'idempotencyKey':f'auto-hola-open-{phone}'
    }
    r=requests.post(base+'/api/ai/meta/oauth/test-send',headers=H,json=payload,timeout=25)
    print(phone,r.status_code,r.text[:220])
