import json, time, hmac, hashlib, urllib.request

url='http://127.0.0.1:4000/api/whatsapp-cloud/webhook'

payload={"object":"whatsapp_business_account","entry":[{"changes":[{"value":{"messages":[{"id":"wamid.sigtest.invalid.1","from":"5493415551234","timestamp":str(int(time.time())),"type":"text","text":{"body":"test invalid signature"}}]}}]}]}
body=json.dumps(payload).encode('utf-8')
req=urllib.request.Request(url,data=body,method='POST',headers={'Content-Type':'application/json','x-hub-signature-256':'sha256=deadbeef'})
try:
  r=urllib.request.urlopen(req,timeout=20)
  print('invalid_sig_status',r.status,'body',r.read().decode()[:180])
except Exception as e:
  if hasattr(e,'code'):
    print('invalid_sig_status',e.code,'body',e.read().decode()[:180])
  else:
    print('invalid_sig_err',e)

secret='ac837baf1c7246e6376fac174001560a'
payload2={"object":"whatsapp_business_account","entry":[{"changes":[{"value":{"messages":[{"id":"wamid.sigtest.valid.1","from":"5493415551234","timestamp":str(int(time.time())),"type":"text","text":{"body":"test valid signature"}}]}}]}]}
body2=json.dumps(payload2).encode('utf-8')
sig=hmac.new(secret.encode(), body2, hashlib.sha256).hexdigest()
req2=urllib.request.Request(url,data=body2,method='POST',headers={'Content-Type':'application/json','x-hub-signature-256':'sha256='+sig})
try:
  r2=urllib.request.urlopen(req2,timeout=20)
  print('valid_sig_status',r2.status,'body',r2.read().decode()[:180])
except Exception as e:
  if hasattr(e,'code'):
    print('valid_sig_status',e.code,'body',e.read().decode()[:180])
  else:
    print('valid_sig_err',e)
