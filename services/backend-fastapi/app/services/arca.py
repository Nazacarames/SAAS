"""
Facturación electrónica ARCA (ex AFIP) — WSAA + WSFEv1.

WSAA: firma un LoginTicketRequest con el certificado digital (PKCS#7/CMS)
y obtiene un Ticket de Acceso (token+sign, vigencia 12 h) que se cachea en
la tabla arca_ta. WSFEv1: solicita CAE con FECAESolicitar.

Config (.env):
  ARCA_ENV=homo|prod       (default homo)
  ARCA_CUIT=20xxxxxxxxx    (CUIT del emisor, sin guiones)
  ARCA_CERT_PATH=/etc/arca/cert.pem
  ARCA_KEY_PATH=/etc/arca/private.key
  ARCA_PTO_VTA=1           (punto de venta habilitado para WS)
  ARCA_CBTE_TIPO=11        (11 = Factura C monotributo; 6 = Factura B RI)

Sin credenciales configuradas todo es no-op: is_configured() -> False.
"""
import base64
import json
import logging
import re
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings

log = logging.getLogger("app.arca")

URLS = {
    "homo": {
        "wsaa": "https://wsaahomo.afip.gov.ar/ws/services/LoginCms",
        "wsfe": "https://wswhomo.afip.gov.ar/wsfev1/service.asmx",
    },
    "prod": {
        "wsaa": "https://wsaa.afip.gov.ar/ws/services/LoginCms",
        "wsfe": "https://servicios1.afip.gov.ar/wsfev1/service.asmx",
    },
}

WSFE_NS = "http://ar.gov.afip.dif.FEV1/"


def _env() -> str:
    return (getattr(settings, "arca_env", "") or "homo").lower()


def is_configured() -> bool:
    return bool(
        getattr(settings, "arca_cuit", "")
        and getattr(settings, "arca_cert_path", "")
        and getattr(settings, "arca_key_path", "")
    )


def _ensure_tables(db: Session) -> None:
    db.execute(text(
        """CREATE TABLE IF NOT EXISTS arca_ta (
            service VARCHAR(30) PRIMARY KEY,
            token TEXT NOT NULL,
            sign TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL
        )"""))
    db.execute(text(
        """CREATE TABLE IF NOT EXISTS invoices (
            id BIGSERIAL PRIMARY KEY,
            company_id INTEGER NOT NULL,
            description VARCHAR(255) NOT NULL DEFAULT '',
            amount NUMERIC(12,2) NOT NULL,
            currency VARCHAR(3) NOT NULL DEFAULT 'ARS',
            cbte_tipo INTEGER,
            pto_vta INTEGER,
            cbte_nro BIGINT,
            cae VARCHAR(20),
            cae_vto DATE,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            error TEXT,
            mp_payment_id VARCHAR(40),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )"""))
    db.commit()


# ── WSAA ──────────────────────────────────────────────────────────────

def _sign_tra_cms(tra_xml: bytes) -> str:
    """Sign the LoginTicketRequest as CMS/PKCS#7 (DER) and return base64."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.serialization import pkcs7

    cert = x509.load_pem_x509_certificate(open(settings.arca_cert_path, "rb").read())
    key = serialization.load_pem_private_key(open(settings.arca_key_path, "rb").read(), password=None)
    signed = (
        pkcs7.PKCS7SignatureBuilder()
        .set_data(tra_xml)
        .add_signer(cert, key, hashes.SHA256())
        .sign(serialization.Encoding.DER, [])
    )
    return base64.b64encode(signed).decode()


def _wsaa_login() -> dict:
    """Request a fresh Ticket de Acceso for service wsfe. Returns {token, sign, expires_at}."""
    now = datetime.now(timezone.utc)
    unique_id = int(now.timestamp())
    gen = (now - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%S-00:00")
    exp = (now + timedelta(hours=12)).strftime("%Y-%m-%dT%H:%M:%S-00:00")
    tra = f"""<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header><uniqueId>{unique_id}</uniqueId><generationTime>{gen}</generationTime><expirationTime>{exp}</expirationTime></header>
  <service>wsfe</service>
</loginTicketRequest>"""
    cms_b64 = _sign_tra_cms(tra.encode())

    envelope = f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Body><wsaa:loginCms><wsaa:in0>{cms_b64}</wsaa:in0></wsaa:loginCms></soapenv:Body>
</soapenv:Envelope>"""
    resp = httpx.post(
        URLS[_env()]["wsaa"], content=envelope,
        headers={"Content-Type": "text/xml; charset=utf-8", "SOAPAction": ""},
        timeout=30,
    )
    body = resp.text
    if resp.status_code != 200:
        fault = re.search(r"<faultstring>(.*?)</faultstring>", body, re.S)
        raise RuntimeError(f"WSAA {resp.status_code}: {fault.group(1)[:200] if fault else body[:200]}")

    # loginCmsReturn viene XML-escapado dentro del envelope
    inner = re.search(r"<loginCmsReturn>(.*?)</loginCmsReturn>", body, re.S)
    if not inner:
        raise RuntimeError(f"WSAA sin loginCmsReturn: {body[:200]}")
    xml = inner.group(1).replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&").replace("&quot;", '"')
    token = re.search(r"<token>(.*?)</token>", xml, re.S).group(1)
    sign = re.search(r"<sign>(.*?)</sign>", xml, re.S).group(1)
    exp_m = re.search(r"<expirationTime>(.*?)</expirationTime>", xml)
    expires = datetime.fromisoformat(exp_m.group(1)) if exp_m else now + timedelta(hours=11)
    return {"token": token, "sign": sign, "expires_at": expires}


def get_ta(db: Session) -> dict:
    """Cached Ticket de Acceso; renews via WSAA when < 10 min of validity left."""
    _ensure_tables(db)
    row = db.execute(text("SELECT token, sign, expires_at FROM arca_ta WHERE service = 'wsfe'")).mappings().first()
    now = datetime.now(timezone.utc)
    if row and row["expires_at"] and row["expires_at"] > now + timedelta(minutes=10):
        return {"token": row["token"], "sign": row["sign"]}
    ta = _wsaa_login()
    db.execute(
        text("""INSERT INTO arca_ta (service, token, sign, expires_at) VALUES ('wsfe', :t, :s, :e)
                ON CONFLICT (service) DO UPDATE SET token = :t, sign = :s, expires_at = :e"""),
        {"t": ta["token"], "s": ta["sign"], "e": ta["expires_at"]},
    )
    db.commit()
    return {"token": ta["token"], "sign": ta["sign"]}


# ── WSFEv1 ────────────────────────────────────────────────────────────

def _wsfe_call(action: str, inner_xml: str) -> str:
    envelope = f"""<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="{WSFE_NS}">
  <soap:Body><ar:{action}>{inner_xml}</ar:{action}></soap:Body>
</soap:Envelope>"""
    resp = httpx.post(
        URLS[_env()]["wsfe"], content=envelope,
        headers={"Content-Type": "text/xml; charset=utf-8", "SOAPAction": f"{WSFE_NS}{action}"},
        timeout=30,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"WSFE {action} HTTP {resp.status_code}: {resp.text[:200]}")
    return resp.text


def _auth_xml(ta: dict) -> str:
    return (f"<ar:Auth><ar:Token>{ta['token']}</ar:Token>"
            f"<ar:Sign>{ta['sign']}</ar:Sign>"
            f"<ar:Cuit>{settings.arca_cuit}</ar:Cuit></ar:Auth>")


def dummy() -> dict:
    """FEDummy: connectivity check, no auth needed."""
    body = _wsfe_call("FEDummy", "")
    out = {}
    for k in ("AppServer", "DbServer", "AuthServer"):
        m = re.search(rf"<{k}>(.*?)</{k}>", body)
        out[k] = m.group(1) if m else "?"
    return out


def _last_voucher(ta: dict, pto_vta: int, cbte_tipo: int) -> int:
    body = _wsfe_call(
        "FECompUltimoAutorizado",
        _auth_xml(ta) + f"<ar:PtoVta>{pto_vta}</ar:PtoVta><ar:CbteTipo>{cbte_tipo}</ar:CbteTipo>",
    )
    m = re.search(r"<CbteNro>(\d+)</CbteNro>", body)
    if not m:
        raise RuntimeError(f"FECompUltimoAutorizado sin CbteNro: {body[:300]}")
    return int(m.group(1))


def emit_invoice(db: Session, company_id: int, amount: float, description: str = "",
                 mp_payment_id: str = "") -> dict:
    """Emit a Factura (default C, consumidor final) for `amount` ARS.
    Records the result in `invoices` either way. Returns the invoice row dict."""
    _ensure_tables(db)
    inv_id = db.execute(
        text("""INSERT INTO invoices (company_id, description, amount, mp_payment_id, status)
                VALUES (:cid, :d, :a, :mp, 'pending') RETURNING id"""),
        {"cid": company_id, "d": description[:255], "a": amount, "mp": mp_payment_id[:40]},
    ).mappings().first()["id"]
    db.commit()

    if not is_configured():
        db.execute(text("UPDATE invoices SET status = 'skipped', error = 'ARCA no configurado' WHERE id = :id"), {"id": inv_id})
        db.commit()
        return {"id": inv_id, "status": "skipped"}

    try:
        ta = get_ta(db)
        pto_vta = int(getattr(settings, "arca_pto_vta", 1) or 1)
        cbte_tipo = int(getattr(settings, "arca_cbte_tipo", 11) or 11)
        nro = _last_voucher(ta, pto_vta, cbte_tipo) + 1
        today = datetime.now(timezone.utc).strftime("%Y%m%d")
        amt = f"{amount:.2f}"

        # Concepto 2 (servicios), consumidor final (DocTipo 99), Factura C:
        # ImpNeto = total, sin IVA discriminado. CondicionIVAReceptorId 5 = CF.
        detail = f"""{_auth_xml(ta)}
<ar:FeCAEReq>
  <ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>{pto_vta}</ar:PtoVta><ar:CbteTipo>{cbte_tipo}</ar:CbteTipo></ar:FeCabReq>
  <ar:FeDetReq><ar:FECAEDetRequest>
    <ar:Concepto>2</ar:Concepto>
    <ar:DocTipo>99</ar:DocTipo><ar:DocNro>0</ar:DocNro>
    <ar:CbteDesde>{nro}</ar:CbteDesde><ar:CbteHasta>{nro}</ar:CbteHasta>
    <ar:CbteFch>{today}</ar:CbteFch>
    <ar:ImpTotal>{amt}</ar:ImpTotal><ar:ImpTotConc>0</ar:ImpTotConc>
    <ar:ImpNeto>{amt}</ar:ImpNeto><ar:ImpOpEx>0</ar:ImpOpEx>
    <ar:ImpTrib>0</ar:ImpTrib><ar:ImpIVA>0</ar:ImpIVA>
    <ar:FchServDesde>{today}</ar:FchServDesde><ar:FchServHasta>{today}</ar:FchServHasta>
    <ar:FchVtoPago>{today}</ar:FchVtoPago>
    <ar:MonId>PES</ar:MonId><ar:MonCotiz>1</ar:MonCotiz>
    <ar:CondicionIVAReceptorId>5</ar:CondicionIVAReceptorId>
  </ar:FECAEDetRequest></ar:FeDetReq>
</ar:FeCAEReq>"""
        body = _wsfe_call("FECAESolicitar", detail)

        cae_m = re.search(r"<CAE>(\d+)</CAE>", body)
        result_m = re.search(r"<Resultado>(\w)</Resultado>", body)
        if not cae_m or (result_m and result_m.group(1) != "A"):
            errs = "; ".join(re.findall(r"<Msg>(.*?)</Msg>", body))[:400]
            raise RuntimeError(f"CAE rechazado: {errs or body[:300]}")
        cae = cae_m.group(1)
        vto_m = re.search(r"<CAEFchVto>(\d{8})</CAEFchVto>", body)
        cae_vto = f"{vto_m.group(1)[:4]}-{vto_m.group(1)[4:6]}-{vto_m.group(1)[6:]}" if vto_m else None

        db.execute(
            text("""UPDATE invoices SET status = 'issued', cbte_tipo = :ct, pto_vta = :pv,
                    cbte_nro = :nro, cae = :cae, cae_vto = :vto WHERE id = :id"""),
            {"ct": cbte_tipo, "pv": pto_vta, "nro": nro, "cae": cae, "vto": cae_vto, "id": inv_id},
        )
        db.commit()
        log.info("ARCA invoice issued: company=%s nro=%s CAE=%s", company_id, nro, cae)
        return {"id": inv_id, "status": "issued", "cbte_nro": nro, "cae": cae, "cae_vto": cae_vto}
    except Exception as e:
        db.rollback()
        db.execute(text("UPDATE invoices SET status = 'error', error = :e WHERE id = :id"),
                   {"e": str(e)[:500], "id": inv_id})
        db.commit()
        log.error("ARCA invoice error company=%s: %s", company_id, e)
        return {"id": inv_id, "status": "error", "error": str(e)[:200]}
