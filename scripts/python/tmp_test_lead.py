import requests, json, time
base='http://127.0.0.1:4000'
login=requests.post(base+'/api/auth/login',json={'email':'admin@atendechat.com','password':'admin123'},timeout=10)
login.raise_for_status()
H={'Authorization':'Bearer '+login.json()['token'],'Content-Type':'application/json'}

payload={
  'companyId':1,
  'event_id':f'manual-test-{int(time.time())}',
  'leadgen_id':'manual-test-local',
  'form_id':'2132679837548086',
  'form_name':'ECOPUEBLO',
  'field_data':[
    {'name':'full_name','values':['Nazareno Carames']},
    {'name':'phone_number','values':['541127713231']},
    {'name':'email','values':['nachicarames@gmail.com']}
  ]
}
r=requests.post(base+'/api/ai/meta-leads/webhook',json=payload,timeout=20)
print('webhook',r.status_code,r.text[:400])

c=requests.get(base+'/api/contacts',headers=H,timeout=20)
arr=c.json() if isinstance(c.json(),list) else []
found=[x for x in arr if ''.join(ch for ch in str(x.get('number','')) if ch.isdigit())=='541127713231']
print('contacts_found',len(found))
if found:
    ct=found[0]
    print('contact',ct.get('id'),ct.get('name'),ct.get('source'))

conv=requests.get(base+'/api/conversations',headers=H,timeout=20)
convs=conv.json() if isinstance(conv.json(),list) else []
hit=[]
for t in convs:
    contact=t.get('contact') or {}
    if ''.join(ch for ch in str(contact.get('number','')) if ch.isdigit())=='541127713231':
        hit.append(t)
print('conversations_found',len(hit))
if hit:
    t=hit[0]
    print('ticket',t.get('id'),t.get('status'),t.get('lastMessage'))
    contact=t.get('contact') or {}
    m=requests.get(f"{base}/api/messages/{contact.get('id')}",headers=H,timeout=20)
    msgs=m.json() if isinstance(m.json(),list) else []
    print('messages',len(msgs))
    if msgs:
      print('last_msg',msgs[-1].get('fromMe'),str(msgs[-1].get('body',''))[:160])
