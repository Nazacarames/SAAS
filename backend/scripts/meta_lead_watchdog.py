#!/usr/bin/env python3
import os, re, json
import requests
import psycopg2
from psycopg2.extras import RealDictCursor

ENV_PATH = ".env"

def load_env(path):
    if not os.path.exists(path):
      return
    with open(path, "r", encoding="utf-8") as f:
      for line in f:
        line=line.strip()
        if not line or line.startswith('#') or '=' not in line:
          continue
        k,v=line.split('=',1)
        os.environ.setdefault(k.strip(), v.strip())

def digits(v):
    return re.sub(r"\D", "", str(v or ""))

def pick_field(field_data, names):
    arr = field_data if isinstance(field_data, list) else []
    for n in names:
        for x in arr:
            if str(x.get("name", "")).strip().lower() == n.lower():
                vals = x.get("values") or []
                if vals:
                    val = str(vals[0]).strip()
                    if val:
                        return val
    return ""

def fetch_lead(leadgen_id, tokens):
    for tok in tokens:
        if not tok:
            continue
        try:
            url = f"https://graph.facebook.com/v23.0/{leadgen_id}"
            r = requests.get(url, params={
                "fields": "id,created_time,field_data,form_id,ad_id,campaign_id,adgroup_id",
                "access_token": tok
            }, timeout=15)
            j = r.json() if r.text else {}
            if r.status_code == 200 and j.get("id"):
                return j
        except Exception:
            pass
    return None

def main():
    load_env(ENV_PATH)
    conn = psycopg2.connect(
        host=os.getenv("DB_HOST", "127.0.0.1"),
        port=int(os.getenv("DB_PORT", "5432")),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASS"),
        dbname=os.getenv("DB_NAME")
    )
    conn.autocommit = True
    cur = conn.cursor(cursor_factory=RealDictCursor)

    cur.execute('''
      SELECT id, company_id, leadgen_id, form_id, form_name, contact_phone, contact_email, contact_name
      FROM meta_lead_events
      WHERE created_at >= NOW() - INTERVAL '96 hours'
      ORDER BY id DESC
      LIMIT 200
    ''')
    rows = cur.fetchall()

    checked = enriched = upserted = tickets = unresolved = 0

    for r in rows:
        checked += 1
        company_id = int(r.get("company_id") or 0)
        leadgen_id = str(r.get("leadgen_id") or "").strip()
        if not company_id or not leadgen_id:
            continue

        phone = digits(r.get("contact_phone"))
        email = str(r.get("contact_email") or "").strip().lower()
        name = str(r.get("contact_name") or "").strip()

        if not phone and not email and not name:
            cur.execute("SELECT access_token FROM meta_connections WHERE company_id=%s ORDER BY id DESC LIMIT 5", (company_id,))
            tokens = [str(x["access_token"] or "") for x in cur.fetchall()]
            data = fetch_lead(leadgen_id, tokens)
            if data and data.get("id"):
                fd = data.get("field_data") if isinstance(data.get("field_data"), list) else []
                phone = digits(pick_field(fd, ["phone_number", "telefono", "phone", "celular", "whatsapp"]))
                email = pick_field(fd, ["email"]).strip().lower()
                name = pick_field(fd, ["full_name", "nombre", "name"]).strip()
                cur.execute('''
                  UPDATE meta_lead_events
                     SET form_fields_json = CASE WHEN COALESCE(form_fields_json,'') IN ('','{}','[]') THEN %s ELSE form_fields_json END,
                         contact_phone = CASE WHEN COALESCE(contact_phone,'') = '' THEN %s ELSE contact_phone END,
                         contact_email = CASE WHEN COALESCE(contact_email,'') = '' THEN %s ELSE contact_email END,
                         contact_name = CASE WHEN COALESCE(contact_name,'') = '' THEN %s ELSE contact_name END,
                         form_id = COALESCE(NULLIF(form_id,''), %s),
                         updated_at = NOW()
                   WHERE id = %s
                ''', (json.dumps(fd), phone or None, email or None, name or None, str(data.get("form_id") or "") or None, int(r["id"])))
                enriched += 1

        if not phone and not email:
            unresolved += 1
            continue

        source_label = str(r.get("form_name") or (f"Formulario {r.get('form_id')}" if r.get("form_id") else "Meta Lead Ads")).strip()

        cur.execute('''
          SELECT id FROM contacts
           WHERE "companyId"=%s
             AND ((%s<>'' AND REGEXP_REPLACE(COALESCE(number,''),'\\D','','g')=%s)
               OR (%s<>'' AND LOWER(COALESCE(email,''))=%s))
           ORDER BY id DESC LIMIT 1
        ''', (company_id, phone or '', phone or '', email or '', email or ''))
        c = cur.fetchone()
        contact_id = int(c["id"]) if c else 0

        if not contact_id:
            cur.execute('''
              INSERT INTO contacts (name, number, email, source, "leadStatus", isGroup, "companyId", "createdAt", "updatedAt")
              VALUES (%s,%s,%s,%s,'nuevo_ingreso',false,%s,NOW(),NOW()) RETURNING id
            ''', (name or phone or 'Lead Meta', phone or '', email or '', source_label, company_id))
            contact_id = int(cur.fetchone()["id"])
            upserted += 1
        else:
            cur.execute('''
              UPDATE contacts
                 SET name = CASE WHEN COALESCE(name,'')='' THEN %s ELSE name END,
                     email = CASE WHEN COALESCE(email,'')='' THEN %s ELSE email END,
                     source = CASE WHEN COALESCE(source,'')='' OR source IN ('meta_lead_ads','meta-lead-webhook') THEN %s ELSE source END,
                     "updatedAt"=NOW()
               WHERE id=%s
            ''', (name or None, email or None, source_label, contact_id))

        cur.execute('''SELECT id FROM tickets WHERE "companyId"=%s AND "contactId"=%s AND status IN ('open','pending') ORDER BY id DESC LIMIT 1''', (company_id, contact_id))
        t = cur.fetchone()
        if not t:
            cur.execute('''SELECT id FROM whatsapps WHERE "companyId"=%s ORDER BY id ASC LIMIT 1''', (company_id,))
            w = cur.fetchone()
            if w:
                cur.execute('''
                  INSERT INTO tickets ("contactId", "whatsappId", "companyId", status, "unreadMessages", "lastMessage", "createdAt", "updatedAt")
                  VALUES (%s,%s,%s,'pending',0,'Nuevo lead Meta Ads',NOW(),NOW())
                ''', (contact_id, int(w["id"]), company_id))
                tickets += 1

    print(f"[meta-lead-watchdog-py] checked={checked} enriched={enriched} upserted={upserted} tickets={tickets} unresolved={unresolved}")
    cur.close(); conn.close()

if __name__ == '__main__':
    main()
