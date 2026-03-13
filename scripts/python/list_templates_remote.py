import requests
waba='1541011117115865'
token='EAAUDWedCKIkBQZC8PzT59ZAHZCKwGivEwKAZAvD8zJg6L6GLA0ITtDuHw2yAhArVaJlDKiVTZBstg3lq545lQrObuu04jTaK2Njth62iBo23jILQe5iLznlGdAfTjgOJguMx89wUEeOIGnFXbKRQ45wujdgiwGRCW8yG2ZAFXPAg1krJrMWnFt9niT5CxjDe7MrgZDZD'
url=f'https://graph.facebook.com/v23.0/{waba}/message_templates'
params={'access_token':token,'limit':100,'fields':'name,status,language,category'}
r=requests.get(url,params=params,timeout=30)
print('status',r.status_code)
d=r.json()
if r.status_code!=200:
  print(d)
else:
  items=d.get('data',[])
  print('count',len(items))
  for t in items[:100]:
    print('{} | {} | {} | {}'.format(t.get('name'),t.get('status'),t.get('language'),t.get('category')))
