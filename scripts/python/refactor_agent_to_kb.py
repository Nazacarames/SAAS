import requests, json, datetime

BASE='http://127.0.0.1:4000'
login=requests.post(f'{BASE}/api/auth/login',json={'email':'admin@atendechat.com','password':'admin123'},timeout=15)
login.raise_for_status()
token=login.json()['token']
H={'Authorization':f'Bearer {token}','Content-Type':'application/json'}

agents=requests.get(f'{BASE}/api/ai/agents',headers=H,timeout=20)
agents.raise_for_status()
arr=agents.json() if isinstance(agents.json(),list) else []
if not arr:
    raise SystemExit('No agents found')
active=next((a for a in arr if a.get('is_active')),arr[0])
agent_id=active['id']
old_persona=str(active.get('persona') or '').strip()

# Move existing long prompt into Knowledge as canonical business playbook.
ts=datetime.datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')
kb_title='Playbook comercial y operativo (migrado desde instrucciones)'
kb_content=f'''[Migrado automáticamente desde Agente IA el {ts}]

{old_persona}
'''.strip()

created=False
try:
    r=requests.post(f'{BASE}/api/ai/kb/documents',headers=H,json={
        'title':kb_title,
        'category':'general',
        'content':kb_content
    },timeout=25)
    if r.status_code in (200,201):
        created=True
    else:
        print('kb create status',r.status_code,r.text[:300])
except Exception as e:
    print('kb create error',e)

new_persona=(
"Rol: sos asistente comercial de Charlott para leads entrantes de Meta/WhatsApp.\n"
"Objetivo: convertir leads en conversaciones de venta y avanzar fase comercial con datos reales.\n\n"
"Reglas de respuesta:\n"
"1) Responder breve, claro y en tono humano rioplatense.\n"
"2) No inventar datos; si falta info, pedirla.\n"
"3) Priorizar próximos pasos concretos: visita, propuesta, cierre.\n"
"4) Registrar estado comercial correctamente: nuevo_ingreso -> primer_contacto -> calificacion -> propuesta -> cierre -> concretado.\n"
"5) Si hay objeciones, responder con foco comercial y volver a CTA.\n\n"
"Conocimiento: usar Base de Conocimiento para catálogo, condiciones, FAQs y políticas.\n"
"Si hay conflicto entre memoria corta y KB, priorizar KB actualizada."
)

payload={
  'name': active.get('name') or 'Asistente Charlott',
  'persona': new_persona,
  'language': active.get('language') or 'es',
  'model': active.get('model') or 'gpt-4o-mini',
  'welcomeMsg': active.get('welcome_msg') or active.get('welcomeMsg') or '¡Hola! Soy el asistente de Charlott. ¿En qué te ayudo hoy?',
  'isActive': True
}
upd=requests.put(f'{BASE}/api/ai/agents/{agent_id}',headers=H,json=payload,timeout=20)
print('agent_update',upd.status_code,upd.text[:240])
print('kb_created',created)
