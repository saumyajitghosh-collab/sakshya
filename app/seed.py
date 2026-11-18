"""Reference data (para 38 control areas) and the shared demo workspace. All demo entities are fictional."""
from werkzeug.security import generate_password_hash
from flask import current_app

from . import audit, storage
from .extensions import db
from .models import (
    ActivityLog, AuditorFirm, Blob, BoardReport, ControlArea, Evidence, Incident, IncidentEvent,
    Observation, ServiceRecord, Tenant, User, Vendor, now_ms,
)
from .periods import add_months, fy_of, periods_for

DAY = 86_400_000
HOUR = 3_600_000
MIN = 60_000

# key, name (verbatim from para 38), cadence, design artefacts required, operating evidence source, owner
AREAS = [
    ("gov", "Information Security Governance", "m", 2, "Board sub-committee KRI pack", "CISO"),
    ("acc", "Access Control", "m", 1, "PAM session logs and access review export", "IAM lead"),
    ("hw", "Hardware Management", "m", 1, "CMDB reconciliation report", "Infrastructure lead"),
    ("net", "Network Security", "m", 2, "Firewall rule review export", "Network lead"),
    ("data", "Data Security", "m", 1, "DLP incident export", "CISO"),
    ("phys", "Physical and Environmental Security", "q", 1, "Data centre access log extract", "Facilities"),
    ("hr", "Human Resource Security", "m", 1, "HRMS exits matched to directory disables", "HR operations"),
    ("bcm", "Business Continuity Management", "h", 1, "DR drill report", "BCM lead"),
    ("scal", "System Scalability", "m", 1, "Peak TPS against provisioned capacity", "SRE lead"),
    ("proj", "IT Project Management", "q", 1, "Steering committee minutes", "PMO"),
    ("vend", "Vendor/Third Party Risk Management", "q", 1, "Vendor assurance register snapshot", "Vendor management"),
    ("inc", "Incident Management", "m", 1, "Six-Hour Desk filing log", "SOC lead"),
    ("chg", "Change Management", "m", 1, "ITSM change tickets with CAB approval", "Change manager"),
    ("patch", "Patch Management", "m", 1, "Patch compliance scan", "Infrastructure lead"),
    ("log", "Log Management", "m", 1, "SIEM ingestion health report", "SOC lead"),
    ("mail", "Secure Mail and Messaging systems", "m", 1, "DMARC aggregate reports", "IT operations"),
    ("dev", "Mobile and/or other Input / Output Device Management Policy", "m", 1, "MDM compliance export", "IT operations"),
    ("test", "Security Testing and Source Code Review", "h", 1, "VA, PT and source code review report", "AppSec lead"),
    ("online", "Online Systems Security", "m", 1, "API gateway anomaly report", "AppSec lead"),
    ("mob", "Mobile Online Services", "m", 1, "App attestation and device-binding report", "Mobile lead"),
]

DEFAULT_PRICING = {
    "platform": 300000, "perArea": 25000, "perVendor": 15000, "desk": 200000,
    "audHrs": 10, "audRate": 4500, "audCut": 50, "intHrs": 60, "intRate": 1800, "intCut": 60,
    "filings": 12, "asmManual": 4, "asmTool": 1, "team": 3, "vendorHrs": 16,
}

# demo design artefacts: key -> [(name, source, days ago, status)]
_DEMO_TOD = {
    "gov": [("Board-approved information security policy v4.2", "Policy library", 200, "accepted"),
            ("IT oversight sub-committee minutes, Q2", "Board portal", 40, "accepted")],
    "acc": [("Access control standard v3", "Policy library", 300, "accepted")],
    "hw": [("IT asset management procedure", "Policy library", 420, "accepted")],
    "net": [("Network segmentation design", "Architecture repository", 150, "accepted"),
            ("Firewall rulebase standard", "Policy library", 260, "submitted")],
    "data": [("Data classification and DLP standard", "Policy library", 90, "accepted")],
    "phys": [("Colocation data centre assurance letter", "Vendor portal", 100, "submitted")],
    "hr": [("Joiner, mover and leaver procedure", "HR policy library", 210, "accepted")],
    "bcm": [("Business continuity plan v3", "BCP repository", 330, "accepted")],
    "scal": [("Capacity plan FY 2026-27", "Architecture repository", 180, "accepted")],
    "proj": [("Project governance SOP", "PMO", 250, "accepted")],
    "vend": [("Board-approved ecosystem adherence policy (para 5)", "Board portal", 60, "accepted")],
    "inc": [("Incident response plan (para 22)", "Policy library", 120, "accepted")],
    "chg": [("Change management policy", "Policy library", 230, "accepted")],
    "patch": [("Patch SLA standard", "Policy library", 190, "accepted")],
    "log": [("Log management and retention standard", "Policy library", 140, "accepted")],
    "mail": [("Mail security configuration baseline", "Configuration repository", 380, "accepted")],
    "dev": [],
    "test": [("Application security testing standard (para 18)", "Policy library", 110, "accepted")],
    "online": [("Web and API security standard (para 24)", "Policy library", 160, "accepted")],
    "mob": [("Wallet app security design (para 31)", "Architecture repository", 75, "submitted")],
}
# demo: operating periods with no evidence, by period index
_DEMO_MISS = {"acc": [4, 5], "data": [6], "phys": [1], "vend": [1], "patch": [3], "dev": [2, 3], "mob": [6]}

DEMO_USERS = [
    ("admin@kestrel.demo", "Ananya Rao", "admin"),
    ("compliance@kestrel.demo", "Vikram Shetty", "compliance"),
    ("auditor@kestrel.demo", "R. Iyer (system auditor)", "auditor"),
    ("board@kestrel.demo", "Meera Kulkarni (Board)", "viewer"),
]


def create_areas(tenant):
    for pos, (key, name, cad, req, src, owner) in enumerate(AREAS):
        db.session.add(ControlArea(tenant_id=tenant.id, key=key, name=name, cadence=cad, tod_required=req,
                                   toe_source=src, owner=owner, applicable=True, position=pos))


def _demo_file(tenant, area_or_vendor, kind, name, source, at, status, period=None, vendor=False):
    body = (
        f"DEMO ARTEFACT (fictional)\nEntity: {tenant.name}\nArtefact: {name}\nSource: {source}\n"
        f"Period: {period or 'n/a'}\nCollected: {at}\n"
    ).encode()
    sha = storage.sha256_bytes(body)
    ev = Evidence(tenant_id=tenant.id, kind=kind, period=period, name=name, source=source, collected_at=at,
                  sha256=sha, status=status, filename=f"{kind}-{sha[:10]}.txt",
                  content_type="text/plain", size=len(body), uploaded_by="seed")
    if vendor:
        ev.vendor_id = area_or_vendor.id
    else:
        ev.area_id = area_or_vendor.id
    db.session.add(ev)
    db.session.flush()
    storage.store(ev, body)
    return ev


def seed_demo_content(tenant):
    t = now_ms()
    fy = fy_of(t, tenant.fy_type)
    tenant.business = "PPI issuer: wallet and prepaid card"
    tenant.contact = "Ananya Rao, CISO"
    tenant.phone = "+91 80 0000 0000"
    tenant.pricing = dict(DEFAULT_PRICING)
    areas = {a.key: a for a in ControlArea.query.filter_by(tenant_id=tenant.id)}
    for key, area in areas.items():
        for name, src, ago, status in _DEMO_TOD.get(key, []):
            _demo_file(tenant, area, "tod", name, src, t - ago * DAY, status)
        for p in periods_for(fy, area.cadence):
            if p["end"] > t or p["n"] in _DEMO_MISS.get(key, []):
                continue
            status = "accepted" if t - p["end"] > 45 * DAY else "submitted"
            _demo_file(tenant, area, "toe", f"{area.toe_source} · {p['label']}", "Automated collector",
                       min(t, p["end"] + 2 * DAY), status, period=p["key"])

    for ref, area, title, sev, ago, src, status in [
        ("OBS-26-03", "acc", "Privileged accounts not reviewed quarterly", "High", 130, "System audit, previous cycle", "open"),
        ("OBS-26-05", "dev", "No documented policy for removable media and mobile devices", "Medium", 95, "System audit, previous cycle", "open"),
        ("OBS-26-07", "patch", "Critical patches beyond the 30-day SLA on three servers", "High", 60, "System audit, previous cycle", "submitted"),
        ("OBS-26-09", "mob", "12-hour cooling period after mobile number change not enforced on the web channel (para 31(g))", "High", 20, "Internal review", "open"),
        ("OBS-26-01", "hw", "Asset register not reconciled with CMDB", "Medium", 150, "System audit, previous cycle", "closed"),
    ]:
        db.session.add(Observation(tenant_id=tenant.id, ref=ref, area_key=area, title=title, severity=sev,
                                   raised=t - ago * DAY, source=src, status=status))

    firms = [
        AuditorFirm(tenant_id=tenant.id, name="Northgate Systems Audit LLP", basis="CERT-In empanelled", sisters=["Northgate Cyber Advisory Pvt Ltd"]),
        AuditorFirm(tenant_id=tenant.id, name="Keystone IS Assurance LLP", basis="CISA-certified (ISACA)", sisters=["Keystone Risk Consulting LLP"]),
        AuditorFirm(tenant_id=tenant.id, name="Varuna Audit and Assurance", basis="DISA (ICAI)", sisters=[]),
    ]
    db.session.add_all(firms)
    db.session.flush()
    tenant.auditor_id = firms[0].id
    cur = fy["sy"]
    for provider, service, fy_ in [
        ("Northgate Cyber Advisory Pvt Ltd", "VA/PT of the wallet app", cur - 1),
        ("Arclight Infotech Pvt Ltd", "Managed SIEM and SOC", cur),
        ("Keystone Risk Consulting LLP", "ISO 27001 gap assessment", cur - 3),
        ("Tessera Payments Tech", "Wallet ledger licence and support", cur),
    ]:
        db.session.add(ServiceRecord(tenant_id=tenant.id, provider=provider, service=service, fy=fy_))

    d = t - (2 * HOUR + 14 * MIN)
    live = Incident(
        tenant_id=tenant.id, ref="INC-0412", title="Credential stuffing on the wallet login API with account takeovers",
        cat="Cyber attack", cyber=True, detected=d,
        systems="Wallet login API, authentication service, device-binding service",
        impact={"customers": 37, "txns": 64, "value": 318450},
        actions="Login API rate limit lowered to 20 requests per minute per IP; 412 source IPs blocked at the WAF\n"
                "Outbound transfers frozen on the 37 affected wallets\n"
                "Device bindings revoked and credential reset forced for affected customers\n"
                "Affected customers notified by SMS and in-app message",
        status="Contained; root cause under investigation", window_pulled=True,
        ms={"triaged": d + 18 * MIN, "evidence": d + 52 * MIN}, created_by="seed")
    db.session.add(live)
    db.session.flush()
    for off, src, text in [
        (-95, "API-GW", "/v2/auth/login p95 latency 2.4x baseline; 1,840 requests/min"),
        (-80, "WAF", "3,112 requests blocked by credential-stuffing heuristic; top source 203.0.113.47"),
        (-64, "AUTH", "14,920 failed logins in 15 min from 412 IPs across 3 ASNs; sample 198.51.100.23"),
        (-41, "AUTH", "37 successful logins following 5 or more failures on the same account"),
        (-33, "DEVICE", "37 new device registrations; 31 completed OTP re-binding"),
        (-22, "FRAUD", "64 wallet-to-bank transfers from flagged accounts, ₹3,18,450"),
        (-12, "CARE", "9 customer complaints of unauthorised debit"),
        (0, "SIEM", "Correlation rule COR-ATO-03 fired: account takeover pattern across AUTH, DEVICE and payments"),
        (9, "SOC", "Rate limit lowered to 20/min per IP; 412 IPs blocked at WAF"),
        (26, "PAYMENTS", "Outbound transfers frozen on 37 affected wallets"),
        (41, "CARE", "Affected customers notified; forced credential reset"),
        (70, "SOC", "No further successful logins from flagged ASNs; source 192.0.2.188 still probing"),
    ]:
        db.session.add(IncidentEvent(incident_id=live.id, at=d + off * MIN, src=src, text=text))

    def closed(ref, title, cat, cyber, det, offs, impact, systems, action):
        ms = {"triaged": det + offs[0] * MIN, "evidence": det + offs[1] * MIN, "draft": det + offs[2] * MIN,
              "approved": det + offs[3] * MIN, "rbi": det + offs[4] * MIN}
        if cyber:
            ms["certin"] = det + (offs[5] if len(offs) > 5 else offs[4]) * MIN
        inc = Incident(tenant_id=tenant.id, ref=ref, title=title, cat=cat, cyber=cyber, detected=det, systems=systems,
                       impact=impact, actions=action, status="Resolved", window_pulled=True, ms=ms, created_by="seed")
        db.session.add(inc)
        db.session.flush()
        db.session.add(IncidentEvent(incident_id=inc.id, at=det - 20 * MIN, src="MONITOR", text=f"First anomaly recorded on {systems}"))
        db.session.add(IncidentEvent(incident_id=inc.id, at=det, src="SIEM", text=f"Alert raised and incident opened: {title}"))

    closed("INC-0409", "Settlement file to sponsor bank delayed by 2h 10m", "Settlement delay", False, t - 12 * DAY - 5 * HOUR,
           [15, 40, 125, 190, 221], {"customers": 0, "txns": 18240, "value": 61200000}, "Core banking batch window",
           "Batch re-run after file-transfer certificate renewal; sponsor bank confirmed receipt")
    closed("INC-0403", "Wallet top-up through cards unavailable for 47 minutes", "Outage of critical system or infrastructure", False,
           t - 31 * DAY - 7 * HOUR, [12, 55, 210, 280, 322], {"customers": 5120, "txns": 6930, "value": 9850000},
           "Card top-up gateway", "Failover to secondary acquirer route; root cause traced to expired TLS certificate")
    closed("INC-0398", "Phishing site imitating the wallet login page", "Cyber attack", True, t - 58 * DAY - 3 * HOUR,
           [25, 95, 290, 370, 408, 355], {"customers": 0, "txns": 0, "value": 0}, "Customer login journey (external)",
           "Takedown requested through anti-phishing service; customer advisory published")

    for v in [
        dict(name="Arclight Infotech Pvt Ltd", service="Managed SIEM and SOC", critical=True, agreement=True, assurance_to=t + 245 * DAY),
        dict(name="Tessera Payments Tech", service="Wallet core ledger (procured application)", critical=True, agreement=True,
             assurance_to=t + 200 * DAY, procured=True, escrow=True, dev_cert=t - 120 * DAY, last_change=t - 30 * DAY),
        dict(name="Nimbus Cloud India", service="IaaS hosting for the wallet stack", critical=True, agreement=True,
             assurance_to=t + 150 * DAY, cloud=True, csp_audit=t - 300 * DAY, csp_board=False),
        dict(name="Brightline KYC Services", service="Video KYC", critical=True, agreement=False),
        dict(name="Orbitel Messaging", service="OTP and transaction alerts over SMS", critical=True, agreement=True, assurance_to=t - 20 * DAY),
        dict(name="Ledgerline Card Processing", service="Prepaid card processing (procured application)", critical=True,
             agreement=True, assurance_to=t + 260 * DAY, procured=True, escrow=False, dev_cert=t - 40 * DAY, last_change=t - 90 * DAY),
        dict(name="Penwise Payroll", service="Payroll SaaS", critical=False, agreement=False),
    ]:
        db.session.add(Vendor(tenant_id=tenant.id, **v))

    tenant.board_meeting = t + 23 * DAY
    tenant.board_dr = t - 170 * DAY
    tenant.board_backup = t - 200 * DAY
    tenant.board_bcp = t - 330 * DAY
    for name, by, ago, placed in [
        ("Wallet app VA/PT report", "Northgate Cyber Advisory", 25, False),
        ("Source code review, Tessera ledger v5.3", "Internal AppSec", 12, False),
        ("Network vulnerability assessment, H1", "Arclight Infotech", 70, True),
    ]:
        db.session.add(BoardReport(tenant_id=tenant.id, name=name, by=by, received=t - ago * DAY, placed=placed))
    audit.log(tenant.id, "system", "demo.seeded", {"fy": fy["label"]})


def create_tenant(name, segment="medium", fy_type="apr", business="", contact="", phone=""):
    tenant = Tenant(name=name, segment=segment, fy_type=fy_type, business=business, contact=contact, phone=phone,
                    pricing=dict(DEFAULT_PRICING))
    db.session.add(tenant)
    db.session.flush()
    create_areas(tenant)
    db.session.flush()
    return tenant


def ensure_demo_tenant():
    tenant = Tenant.query.filter_by(is_demo=True).first()
    if tenant:
        return tenant
    tenant = create_tenant("Kestrel Wallet Pvt Ltd")
    tenant.is_demo = True
    pw = generate_password_hash(current_app.config["DEMO_PASSWORD"])
    for email, name, role in DEMO_USERS:
        if not User.query.filter_by(email=email).first():
            db.session.add(User(tenant_id=tenant.id, email=email, name=name, role=role, password_hash=pw))
    seed_demo_content(tenant)
    db.session.commit()
    return tenant


def wipe_tenant_content(tenant):
    ev_ids = [e.id for e in Evidence.query.with_entities(Evidence.id).filter_by(tenant_id=tenant.id)]
    if ev_ids:
        Blob.query.filter(Blob.evidence_id.in_(ev_ids)).delete(synchronize_session=False)
    Evidence.query.filter_by(tenant_id=tenant.id).delete(synchronize_session=False)
    inc_ids = [i.id for i in Incident.query.with_entities(Incident.id).filter_by(tenant_id=tenant.id)]
    if inc_ids:
        IncidentEvent.query.filter(IncidentEvent.incident_id.in_(inc_ids)).delete(synchronize_session=False)
    for model in (Incident, Observation, AuditorFirm, ServiceRecord, Vendor, BoardReport, ActivityLog):
        model.query.filter_by(tenant_id=tenant.id).delete(synchronize_session=False)
    ControlArea.query.filter_by(tenant_id=tenant.id).update({"applicable": True})
    tenant.auditor_id = None


def reset_demo_tenant():
    tenant = Tenant.query.filter_by(is_demo=True).first()
    if not tenant:
        return ensure_demo_tenant()
    wipe_tenant_content(tenant)
    db.session.flush()
    seed_demo_content(tenant)
    db.session.commit()
    return tenant
