"""App shell and JSON API. Every query is scoped to the signed-in user's tenant."""
import csv
import io
import json
import re
import zipfile
from datetime import datetime, timezone

from flask import Blueprint, Response, current_app, g, jsonify, render_template, request, send_file
from werkzeug.security import generate_password_hash

from . import audit, storage
from .auth import EDITORS, ROLES, login_required, roles
from .extensions import db
from .models import (ActivityLog, AuditorFirm, BoardReport, ControlArea, Evidence, Incident, IncidentEvent,
                     Observation, ServiceRecord, User, Vendor, now_ms)
from .periods import add_months, fy_label, fy_of
from .seed import DEFAULT_PRICING, reset_demo_tenant

bp = Blueprint("api", __name__)

CATS = ["Cyber attack", "Outage of critical system or infrastructure", "Internal fraud", "Settlement delay",
        "Other unusual incident"]
MILESTONES = ["triaged", "evidence", "draft", "approved", "rbi", "certin"]
HOUR = 3_600_000
MIN = 60_000


def err(msg, code=400):
    return jsonify(error=msg), code


def body():
    return request.get_json(silent=True) or {}


def T():
    return g.tenant


def actor():
    return g.user.email


def q(model):
    return model.query.filter_by(tenant_id=T().id)


def ok(**extra):
    db.session.commit()
    return jsonify(state=state(), **extra)


def _int(v, default=None):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _clip(s, n):
    return (s or "").strip()[:n]


# ---------------------------------------------------------------- serialisation
def ev_json(e):
    return {"id": str(e.id), "name": e.name, "source": e.source, "at": e.collected_at, "hash": e.sha256,
            "status": e.status, "period": e.period, "hasFile": bool(e.storage), "filename": e.filename,
            "size": e.size, "by": e.uploaded_by, "kind": e.kind}


def state():
    t = T()
    evs = Evidence.query.filter_by(tenant_id=t.id, superseded=False).order_by(Evidence.collected_at.asc()).all()
    by_area, by_vendor = {}, {}
    for e in evs:
        if e.area_id:
            by_area.setdefault(e.area_id, []).append(e)
        elif e.vendor_id:
            by_vendor.setdefault(e.vendor_id, []).append(e)
    areas = []
    for a in q(ControlArea).order_by(ControlArea.position).all():
        items = by_area.get(a.id, [])
        areas.append({"id": a.key, "name": a.name, "cad": a.cadence, "todReq": a.tod_required,
                      "toeSource": a.toe_source, "owner": a.owner, "applicable": a.applicable,
                      "tod": [ev_json(e) for e in items if e.kind == "tod"],
                      "toe": [ev_json(e) for e in items if e.kind == "toe"]})
    incidents = []
    for i in q(Incident).order_by(Incident.detected.desc()).all():
        evts = IncidentEvent.query.filter_by(incident_id=i.id).order_by(IncidentEvent.at).all()
        incidents.append({"id": i.ref, "title": i.title, "cat": i.cat, "cyber": i.cyber, "detected": i.detected,
                          "systems": i.systems or "", "impact": i.impact or {}, "actions": i.actions or "",
                          "status": i.status or "", "windowPulled": i.window_pulled, "narrative": i.narrative,
                          "ms": i.ms or {}, "events": [{"at": e.at, "src": e.src, "text": e.text} for e in evts]})
    vendors = []
    for v in q(Vendor).order_by(Vendor.id).all():
        vendors.append({"id": str(v.id), "name": v.name, "service": v.service, "critical": v.critical,
                        "agreement": v.agreement, "assuranceTo": v.assurance_to, "procured": v.procured,
                        "sourceObtained": v.source_obtained, "escrow": v.escrow, "devCert": v.dev_cert,
                        "lastChange": v.last_change, "cloud": v.cloud, "cspAudit": v.csp_audit, "cspBoard": v.csp_board,
                        "docs": [ev_json(e) for e in by_vendor.get(v.id, [])]})
    pricing = dict(DEFAULT_PRICING)
    pricing.update(t.pricing or {})
    return {
        "v": 1, "entity": t.name, "business": t.business or "", "segment": t.segment, "fyType": t.fy_type,
        "contact": t.contact or "", "phone": t.phone or "", "isDemo": t.is_demo,
        "ai": bool(current_app.config.get("ANTHROPIC_API_KEY")),
        "payUrl": current_app.config.get("PAYMENT_URL") or None,
        "me": {"name": g.user.name, "email": g.user.email, "role": g.user.role},
        "areas": areas,
        "obs": [{"id": o.ref, "area": o.area_key, "title": o.title, "sev": o.severity, "raised": o.raised,
                 "source": o.source, "status": o.status} for o in q(Observation).order_by(Observation.raised.desc())],
        "auditors": [{"id": str(a.id), "name": a.name, "basis": a.basis, "sisters": a.sisters or []}
                     for a in q(AuditorFirm).order_by(AuditorFirm.id)],
        "auditor": str(t.auditor_id) if t.auditor_id else None,
        "services": [{"id": str(s.id), "provider": s.provider, "service": s.service, "fy": s.fy}
                     for s in q(ServiceRecord).order_by(ServiceRecord.fy.desc(), ServiceRecord.id)],
        "incidents": incidents,
        "vendors": vendors,
        "board": {"meeting": t.board_meeting, "dr": t.board_dr, "backup": t.board_backup, "bcp": t.board_bcp,
                  "reports": [{"id": str(r.id), "name": r.name, "by": r.by, "received": r.received, "placed": r.placed}
                              for r in q(BoardReport).order_by(BoardReport.received.desc())]},
        "pricing": pricing,
    }


# ---------------------------------------------------------------- shell
@bp.get("/")
@login_required
def app_shell():
    return render_template("app.html")


@bp.get("/api/state")
@login_required
def get_state():
    return jsonify(state=state())


# ---------------------------------------------------------------- settings
@bp.post("/api/settings")
@login_required
@roles(*EDITORS)
def settings():
    t, b, changed = T(), body(), {}
    if b.get("segment") in ("large", "medium", "small"):
        t.segment = changed["segment"] = b["segment"]
    if b.get("fyType") in ("apr", "cal"):
        t.fy_type = changed["fyType"] = b["fyType"]
    if "auditor" in b:
        firm = q(AuditorFirm).filter_by(id=_int(b["auditor"], -1)).first()
        if not firm:
            return err("Unknown auditor firm.")
        t.auditor_id = changed["auditor"] = firm.id
    if "meeting" in b:
        m = _int(b["meeting"])
        if not m:
            return err("Enter a meeting date.")
        t.board_meeting = changed["meeting"] = m
    for key, n in (("entity", 200), ("business", 200), ("contact", 200), ("phone", 50)):
        if key in b and isinstance(b[key], str):
            val = _clip(b[key], n)
            if key == "entity" and not val:
                return err("The entity name cannot be empty.")
            setattr(t, "name" if key == "entity" else key, val)
            changed[key] = val
    if isinstance(b.get("pricing"), dict):
        p = dict(DEFAULT_PRICING)
        p.update(t.pricing or {})
        for k, v in b["pricing"].items():
            if k in DEFAULT_PRICING:
                try:
                    p[k] = max(0.0, float(v))
                except (TypeError, ValueError):
                    pass
        t.pricing = p
        changed["pricing"] = True
    if not changed:
        return err("Nothing to change.")
    audit.log(t.id, actor(), "settings.updated", changed)
    return ok()


# ---------------------------------------------------------------- control areas and evidence
def _area(key):
    return q(ControlArea).filter_by(key=key).first()


@bp.post("/api/areas/<key>/applicable")
@login_required
@roles(*EDITORS)
def area_applicable(key):
    a = _area(key)
    if not a:
        return err("Unknown control area.", 404)
    a.applicable = bool(body().get("applicable"))
    audit.log(T().id, actor(), "area.applicability", {"area": a.name, "applicable": a.applicable})
    return ok()


@bp.post("/api/evidence")
@login_required
@roles(*EDITORS)
def add_evidence():
    f = request.form
    a = _area(f.get("area", ""))
    if not a:
        return err("Unknown control area.", 404)
    kind = f.get("kind")
    if kind not in ("tod", "toe"):
        return err("Choose design or operating evidence.")
    period = _clip(f.get("period"), 40) if kind == "toe" else None
    if kind == "toe" and not period:
        return err("Choose the period this evidence covers.")
    upload = request.files.get("file")
    data = upload.read() if upload and upload.filename else None
    name = _clip(f.get("name"), 300) or (upload.filename if data is not None else "")
    if not name:
        return err("Choose a file or enter an artefact name.")
    e = Evidence(tenant_id=T().id, area_id=a.id, kind=kind, period=period, name=name,
                 source=_clip(f.get("source"), 200) or "Manual upload", collected_at=now_ms(), status="draft",
                 uploaded_by=actor())
    if data is not None:
        e.sha256 = storage.sha256_bytes(data)
        e.filename = _clip(upload.filename, 300)
        e.content_type = upload.mimetype or "application/octet-stream"
        e.size = len(data)
    if kind == "toe":
        prev = Evidence.query.filter_by(tenant_id=T().id, area_id=a.id, kind="toe", period=period,
                                        superseded=False).all()
        for p in prev:
            p.superseded = True
    db.session.add(e)
    db.session.flush()
    if data is not None:
        storage.store(e, data)
    audit.log(T().id, actor(), "evidence.added", {"area": a.name, "kind": kind, "period": period, "name": name,
                                                  "sha256": e.sha256, "evidence_id": e.id})
    return ok(sha256=e.sha256)


@bp.post("/api/evidence/<int:eid>/status")
@login_required
def evidence_status(eid):
    e = q(Evidence).filter_by(id=eid, superseded=False).first()
    if not e:
        return err("Unknown evidence.", 404)
    new = body().get("status")
    role = g.user.role
    allowed = {
        "admin": {("draft", "submitted"), ("submitted", "draft")},
        "compliance": {("draft", "submitted"), ("submitted", "draft")},
        "auditor": {("submitted", "accepted"), ("accepted", "submitted")},
    }.get(role, set())
    if (e.status, new) not in allowed:
        return err("Your role cannot make that change. Only the system auditor can mark evidence as relied on.", 403)
    old, e.status = e.status, new
    audit.log(T().id, actor(), "evidence.status", {"evidence_id": e.id, "name": e.name, "from": old, "to": new,
                                                   "sha256": e.sha256})
    return ok()


@bp.get("/api/evidence/<int:eid>/file")
@login_required
def evidence_file(eid):
    e = q(Evidence).filter_by(id=eid).first()
    if not e or not e.storage:
        return err("No file is stored for this evidence.", 404)
    data = storage.load(e)
    if data is None:
        return err("The stored file could not be read.", 500)
    return send_file(io.BytesIO(data), mimetype=e.content_type or "application/octet-stream", as_attachment=True,
                     download_name=e.filename or f"evidence-{e.id}")


# ---------------------------------------------------------------- observations (paras 39-41)
@bp.post("/api/observations")
@login_required
@roles(*EDITORS + ("auditor",))
def add_observation():
    b = body()
    title = _clip(b.get("title"), 400)
    a = _area(b.get("area", ""))
    raised = _int(b.get("raised"))
    if not title or not a or not raised:
        return err("Enter the observation, its control area and the date raised.")
    sy = fy_of(now_ms(), T().fy_type)["sy"]
    n = q(Observation).count() + 1
    ref = f"OBS-{str(sy + 1)[2:]}-{n:02d}"
    while q(Observation).filter_by(ref=ref).first():
        n += 1
        ref = f"OBS-{str(sy + 1)[2:]}-{n:02d}"
    sev = b.get("sev") if b.get("sev") in ("High", "Medium", "Low") else "Medium"
    o = Observation(tenant_id=T().id, ref=ref, area_key=a.key, title=title, severity=sev, raised=raised,
                    source=_clip(b.get("source"), 120) or "System audit", status="open")
    db.session.add(o)
    audit.log(T().id, actor(), "observation.logged", {"ref": ref, "area": a.name, "title": title})
    return ok()


@bp.post("/api/observations/<ref>/status")
@login_required
def observation_status(ref):
    o = q(Observation).filter_by(ref=ref).first()
    if not o:
        return err("Unknown observation.", 404)
    new = body().get("status")
    allowed = {
        "admin": {("open", "submitted"), ("closed", "open")},
        "compliance": {("open", "submitted"), ("closed", "open")},
        "auditor": {("submitted", "closed"), ("submitted", "open"), ("closed", "open")},
    }.get(g.user.role, set())
    if (o.status, new) not in allowed:
        return err("Your role cannot make that change. Only the auditor can accept a closure.", 403)
    old, o.status = o.status, new
    audit.log(T().id, actor(), "observation.status", {"ref": ref, "from": old, "to": new})
    return ok()


# ---------------------------------------------------------------- auditor independence (paras 36-37)
@bp.post("/api/auditors")
@login_required
@roles(*EDITORS)
def add_auditor():
    b = body()
    name = _clip(b.get("name"), 200)
    if not name:
        return err("Enter the firm's name.")
    basis = b.get("basis") if b.get("basis") in ("CERT-In empanelled", "CISA-certified (ISACA)", "DISA (ICAI)") else "CERT-In empanelled"
    sisters = [_clip(s, 200) for s in (b.get("sisters") or []) if isinstance(s, str) and s.strip()][:20]
    firm = AuditorFirm(tenant_id=T().id, name=name, basis=basis, sisters=sisters)
    db.session.add(firm)
    db.session.flush()
    if not T().auditor_id:
        T().auditor_id = firm.id
    audit.log(T().id, actor(), "auditor.added", {"name": name, "basis": basis, "sisters": sisters})
    return ok()


@bp.post("/api/services")
@login_required
@roles(*EDITORS)
def add_service():
    b = body()
    provider = _clip(b.get("provider"), 200)
    fy = _int(b.get("fy"))
    if not provider or not fy:
        return err("Enter the provider and the year.")
    s = ServiceRecord(tenant_id=T().id, provider=provider, service=_clip(b.get("service"), 300) or "Unspecified service", fy=fy)
    db.session.add(s)
    audit.log(T().id, actor(), "service.recorded", {"provider": provider, "service": s.service, "fy": fy})
    return ok()


@bp.delete("/api/services/<int:sid>")
@login_required
@roles(*EDITORS)
def delete_service(sid):
    s = q(ServiceRecord).filter_by(id=sid).first()
    if not s:
        return err("Unknown entry.", 404)
    audit.log(T().id, actor(), "service.removed", {"provider": s.provider, "service": s.service, "fy": s.fy})
    db.session.delete(s)
    return ok()


# ---------------------------------------------------------------- incidents (para 22(d))
TS = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?")
SRC = re.compile(r"^\[([^\]]{1,24})\]")
SRC2 = re.compile(r"\b(WAF|SIEM|API|AUTH|FRAUD|FIREWALL|EDR|IDS|APP|DB|SOC)\b", re.I)


def parse_logs(text, fallback):
    out = []
    for line in (text or "").splitlines()[:500]:
        line = line.strip()
        if not line:
            continue
        at = fallback
        m = TS.search(line)
        if m:
            raw = m.group(0).replace(" ", "T").replace("Z", "+00:00")
            if re.search(r"[+-]\d{4}$", raw):
                raw = raw[:-2] + ":" + raw[-2:]
            try:
                dt = datetime.fromisoformat(raw)
                if dt.tzinfo is None:
                    from .periods import tz
                    dt = dt.replace(tzinfo=tz())
                at = int(dt.timestamp() * 1000)
            except ValueError:
                pass
        s = SRC.match(line)
        s2 = None if s else SRC2.search(line)
        src = s.group(1) if s else (s2.group(1) if s2 else None)
        txt = SRC.sub("", line).strip()
        if m:
            txt = re.sub(r"\s{2,}", " ", txt.replace(m.group(0), "")).strip()
        out.append({"at": at, "src": (src or "LOG").upper()[:12], "text": (txt or line)[:2000]})
    return out


def _incident(ref):
    return q(Incident).filter_by(ref=ref).first()


@bp.post("/api/incidents")
@login_required
@roles(*EDITORS)
def open_incident():
    b = body()
    title = _clip(b.get("title"), 300)
    detected = _int(b.get("detected"))
    cat = b.get("cat") if b.get("cat") in CATS else None
    if not title or not cat:
        return err("Describe what happened and choose a category.")
    if not detected or detected > now_ms() + MIN:
        return err("Detection time must be now or in the past.")
    nums = [_int(re.sub(r"\D", "", i.ref), 0) for i in q(Incident).with_entities(Incident.ref)]
    ref = f"INC-{(max(nums) if nums else 0) + 1:04d}"
    inc = Incident(tenant_id=T().id, ref=ref, title=title, cat=cat, cyber=bool(b.get("cyber")), detected=detected,
                   systems=_clip(b.get("systems"), 400), impact={"customers": 0, "txns": 0, "value": 0}, actions="",
                   status="Under investigation", window_pulled=False, ms={}, created_by=actor())
    db.session.add(inc)
    db.session.flush()
    logs = parse_logs(b.get("logs"), detected)
    for e in logs:
        db.session.add(IncidentEvent(incident_id=inc.id, **e))
    audit.log(T().id, actor(), "incident.opened", {"ref": ref, "title": title, "category": cat, "cyber": inc.cyber,
                                                   "detected": detected, "events": len(logs)})
    return ok(ref=ref)


@bp.patch("/api/incidents/<ref>")
@login_required
@roles(*EDITORS)
def update_incident(ref):
    inc = _incident(ref)
    if not inc:
        return err("Unknown incident.", 404)
    b = body()
    if "detected" in b:
        return err("The detection time is locked once an incident is opened.", 409)
    changed = []
    for key, n in (("systems", 400), ("status", 200)):
        if key in b:
            setattr(inc, key, _clip(b[key], n))
            changed.append(key)
    if "actions" in b:
        inc.actions = (b["actions"] or "")[:5000]
        changed.append("actions")
    if "narrative" in b:
        inc.narrative = (b["narrative"] or "")[:5000] or None
        changed.append("narrative")
    if "cyber" in b:
        inc.cyber = bool(b["cyber"])
        changed.append("cyber")
    if isinstance(b.get("impact"), dict):
        imp = dict(inc.impact or {})
        for k in ("customers", "txns", "value"):
            if k in b["impact"]:
                imp[k] = max(0, _int(b["impact"][k], 0))
        inc.impact = imp
        changed.append("impact")
    if not changed:
        return err("Nothing to change.")
    audit.log(T().id, actor(), "incident.updated", {"ref": ref, "fields": changed})
    return ok()


@bp.post("/api/incidents/<ref>/events")
@login_required
@roles(*EDITORS)
def add_events(ref):
    inc = _incident(ref)
    if not inc:
        return err("Unknown incident.", 404)
    evs = parse_logs(body().get("logs"), inc.detected)
    if not evs:
        return err("Paste at least one log line.")
    for e in evs:
        db.session.add(IncidentEvent(incident_id=inc.id, **e))
    inc.window_pulled = True
    ms = dict(inc.ms or {})
    ms.setdefault("evidence", now_ms())
    inc.ms = ms
    audit.log(T().id, actor(), "incident.events_added", {"ref": ref, "count": len(evs)})
    return ok(count=len(evs))


@bp.post("/api/incidents/<ref>/milestone")
@login_required
@roles(*EDITORS)
def milestone(ref):
    inc = _incident(ref)
    if not inc:
        return err("Unknown incident.", 404)
    key = body().get("key")
    if key not in MILESTONES:
        return err("Unknown step.")
    if key == "certin" and not inc.cyber:
        return err("CERT-In reporting applies to cyber security incidents.")
    ms = dict(inc.ms or {})
    if key in ms:
        return err("That step is already recorded.", 409)
    t = now_ms()  # server time: the stopwatch cannot be back-dated from the browser
    ms[key] = t
    if key == "evidence":
        inc.window_pulled = True
        ms.setdefault("triaged", t)
    if key == "rbi":
        ms.setdefault("approved", t)
    inc.ms = ms
    audit.log(T().id, actor(), "incident.milestone", {"ref": ref, "step": key, "elapsed_ms": t - inc.detected})
    return ok()


@bp.post("/api/incidents/<ref>/narrative")
@login_required
@roles(*EDITORS)
def draft_narrative(ref):
    inc = _incident(ref)
    if not inc:
        return err("Unknown incident.", 404)
    if not current_app.config.get("ANTHROPIC_API_KEY"):
        return err("Claude drafting is not configured on this server.", 501)
    from .drafting import draft_description
    try:
        text = draft_description(T(), inc, IncidentEvent.query.filter_by(incident_id=inc.id).order_by(IncidentEvent.at).all())
    except Exception as exc:  # pragma: no cover - network
        current_app.logger.warning("Claude drafting failed: %s", exc)
        return err("Claude could not draft this right now. Try again in a minute.", 502)
    inc.narrative = text
    audit.log(T().id, actor(), "incident.narrative_drafted", {"ref": ref, "by": "claude", "chars": len(text)})
    return ok()


# ---------------------------------------------------------------- vendors (paras 5, 17(c), 18(b), 19(c), 26(c))
@bp.post("/api/vendors")
@login_required
@roles(*EDITORS)
def add_vendor():
    b = body()
    name = _clip(b.get("name"), 200)
    if not name:
        return err("Enter the vendor name.")
    v = Vendor(tenant_id=T().id, name=name, service=_clip(b.get("service"), 300) or "Unspecified service",
               critical=bool(b.get("critical")), procured=bool(b.get("procured")), cloud=bool(b.get("cloud")))
    if v.procured:
        v.last_change = now_ms()
    db.session.add(v)
    db.session.flush()
    audit.log(T().id, actor(), "vendor.added", {"vendor": name, "critical": v.critical, "procured": v.procured, "cloud": v.cloud})
    return ok(id=str(v.id))


@bp.post("/api/vendors/<int:vid>/fix")
@login_required
@roles(*EDITORS)
def vendor_fix(vid):
    v = q(Vendor).filter_by(id=vid).first()
    if not v:
        return err("Unknown vendor.", 404)
    fix = request.form.get("fix") or (body().get("fix") if request.is_json else None)
    t = now_ms()
    detail = {"vendor": v.name, "fix": fix}
    if fix == "agreement":
        v.agreement = True
    elif fix == "escrow":
        v.escrow = True
    elif fix == "cspboard":
        v.csp_board = True
    elif fix == "codechange":
        v.last_change = t
    elif fix in ("assurance", "devcert", "cspaudit"):
        d = _int(request.form.get("date"))
        if not d:
            return err("Enter a date.")
        if fix == "assurance" and d <= t:
            return err("The validity date must be in the future.")
        if fix == "devcert" and v.last_change and min(d, t) < v.last_change:
            return err("This certificate predates the last code change. Para 18(b) needs a certificate for the current code.")
        upload = request.files.get("file")
        data = upload.read() if upload and upload.filename else None
        names = {"assurance": "Independent assurance report", "devcert": "Developer certificate", "cspaudit": "CSP independent audit report"}
        e = Evidence(tenant_id=T().id, vendor_id=v.id, kind=f"vendor_{fix}", name=f"{names[fix]} · {v.name}",
                     source="Vendor", collected_at=t, status="draft", uploaded_by=actor())
        if data is not None:
            e.sha256 = storage.sha256_bytes(data)
            e.filename = _clip(upload.filename, 300)
            e.content_type = upload.mimetype or "application/octet-stream"
            e.size = len(data)
        db.session.add(e)
        db.session.flush()
        if data is not None:
            storage.store(e, data)
        if fix == "assurance":
            v.assurance_to = d
        elif fix == "devcert":
            v.dev_cert = min(d, t)
        else:
            v.csp_audit = min(d, t)
            v.csp_board = False
        detail.update({"date": d, "sha256": e.sha256, "evidence_id": e.id})
    else:
        return err("Unknown action.")
    audit.log(T().id, actor(), "vendor.updated", detail)
    return ok()


# ---------------------------------------------------------------- board (paras 11, 12, 20(f), 23)
@bp.post("/api/board/test")
@login_required
@roles(*EDITORS)
def board_test():
    k = body().get("k")
    col = {"dr": "board_dr", "backup": "board_backup", "bcp": "board_bcp"}.get(k)
    if not col:
        return err("Unknown test.")
    setattr(T(), col, now_ms())
    audit.log(T().id, actor(), "board.test_recorded", {"test": k})
    return ok()


@bp.post("/api/board/reports")
@login_required
@roles(*EDITORS)
def add_report():
    b = body()
    name = _clip(b.get("name"), 300)
    received = _int(b.get("received"))
    if not name or not received:
        return err("Enter the report name and the date received.")
    db.session.add(BoardReport(tenant_id=T().id, name=name, by=_clip(b.get("by"), 200), received=received))
    audit.log(T().id, actor(), "board.report_added", {"name": name})
    return ok()


@bp.post("/api/board/reports/<int:rid>/placed")
@login_required
@roles(*EDITORS)
def report_placed(rid):
    r = q(BoardReport).filter_by(id=rid).first()
    if not r:
        return err("Unknown report.", 404)
    r.placed = True
    audit.log(T().id, actor(), "board.report_placed", {"name": r.name})
    return ok()


# ---------------------------------------------------------------- exports
def _pack():
    t = T()
    areas = []
    for a in q(ControlArea).order_by(ControlArea.position):
        evs = Evidence.query.filter_by(tenant_id=t.id, area_id=a.id, superseded=False).order_by(Evidence.collected_at)
        areas.append({"area": a.name, "applicable": a.applicable, "owner": a.owner, "cadence": a.cadence,
                      "evidence": [{"kind": "design" if e.kind == "tod" else "operating", "period": e.period,
                                    "artefact": e.name, "source": e.source, "collected_at": _iso(e.collected_at),
                                    "sha256": e.sha256, "file": e.filename, "auditor_status": e.status,
                                    "uploaded_by": e.uploaded_by} for e in evs]})
    firm = db.session.get(AuditorFirm, t.auditor_id) if t.auditor_id else None
    ok_, count, bad, head = audit.verify(t.id)
    return {
        "generator": "Sakshya evidence pack", "entity": t.name, "segment": t.segment,
        "period": fy_of(now_ms(), t.fy_type)["label"], "generated_at": _iso(now_ms()), "generated_by": actor(),
        "auditor": {"name": firm.name, "basis": firm.basis} if firm else None,
        "activity_log": {"entries": count, "chain_intact": ok_, "head_hash": head},
        "control_areas": areas,
        "observations": [{"ref": o.ref, "area": o.area_key, "title": o.title, "severity": o.severity,
                          "raised": _iso(o.raised)[:10], "corrective_due": _iso(add_months(o.raised, 3))[:10],
                          "status": o.status} for o in q(Observation).order_by(Observation.raised)],
    }


def _iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat().replace("+00:00", "Z") if ms else None


def _csv():
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["control_area", "kind", "period", "artefact", "source", "collected_at", "sha256", "file", "auditor_status", "uploaded_by"])
    areas = {a.id: a for a in q(ControlArea)}
    for e in Evidence.query.filter_by(tenant_id=T().id, superseded=False).filter(Evidence.area_id.isnot(None)).order_by(Evidence.area_id, Evidence.collected_at):
        a = areas.get(e.area_id)
        if a and a.applicable:
            w.writerow([a.name, "design" if e.kind == "tod" else "operating", e.period or "", e.name, e.source,
                        _iso(e.collected_at), e.sha256 or "", e.filename or "", e.status, e.uploaded_by or ""])
    return buf.getvalue()


def _slug(s):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", s or "").strip("-")[:80] or "file"


@bp.get("/api/export/pack.json")
@login_required
def export_pack():
    audit.log(T().id, actor(), "export.pack_json", {})
    db.session.commit()
    return Response(json.dumps(_pack(), indent=2, ensure_ascii=False), mimetype="application/json",
                    headers={"Content-Disposition": f'attachment; filename="sakshya-evidence-pack-{_slug(T().name)}.json"'})


@bp.get("/api/export/manifest.csv")
@login_required
def export_csv():
    audit.log(T().id, actor(), "export.manifest_csv", {})
    db.session.commit()
    return Response(_csv(), mimetype="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="sakshya-evidence-manifest-{_slug(T().name)}.csv"'})


@bp.get("/api/export/evidence.zip")
@login_required
def export_zip():
    """Everything an auditor needs to rely on the evidence: files, manifest, and the verifiable activity log."""
    audit.log(T().id, actor(), "export.evidence_zip", {})
    db.session.commit()
    t = T()
    mem = io.BytesIO()
    areas = {a.id: a for a in q(ControlArea)}
    with zipfile.ZipFile(mem, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(_pack(), indent=2, ensure_ascii=False))
        z.writestr("manifest.csv", _csv())
        for e in Evidence.query.filter_by(tenant_id=t.id, superseded=False).filter(Evidence.storage.isnot(None)):
            data = storage.load(e)
            if data is None:
                continue
            folder = _slug(areas[e.area_id].name) if e.area_id in areas else "vendors"
            sub = "design" if e.kind == "tod" else ("operating" if e.kind == "toe" else e.kind)
            z.writestr(f"files/{folder}/{sub}/{_slug(e.period or '')}{'_' if e.period else ''}{e.sha256[:12]}_{_slug(e.filename)}", data)
        log = [{"seq": x.seq, "at": _iso(x.at), "actor": x.actor, "action": x.action, "detail": json.loads(x.detail),
                "at_ms": x.at, "detail_canonical": x.detail, "prev_hash": x.prev_hash, "hash": x.hash}
               for x in ActivityLog.query.filter_by(tenant_id=t.id).order_by(ActivityLog.seq)]
        z.writestr("activity-log.json", json.dumps({
            "tenant_id": t.id,
            "hash_rule": "sha256(prev_hash|tenant_id|seq|at_ms|actor|action|detail_canonical), genesis prev_hash = 64 zeros",
            "entries": log}, indent=2, ensure_ascii=False))
        z.writestr("README.txt", (
            f"Evidence pack for {t.name}, generated {_iso(now_ms())} by {actor()}.\n"
            "Each file name starts with the first 12 characters of its SHA-256. Recompute the hash of any file and\n"
            "compare it with manifest.csv. activity-log.json lists every action taken in Sakshya, each entry hashed\n"
            "together with the one before it, so any edit or deletion breaks the chain from that point on.\n"))
    mem.seek(0)
    return send_file(mem, mimetype="application/zip", as_attachment=True,
                     download_name=f"sakshya-evidence-{_slug(t.name)}-{datetime.now().strftime('%Y%m%d')}.zip")


# ---------------------------------------------------------------- activity log
@bp.get("/api/activity")
@login_required
def activity():
    limit = min(500, max(1, _int(request.args.get("limit"), 200)))
    rows = ActivityLog.query.filter_by(tenant_id=T().id).order_by(ActivityLog.seq.desc()).limit(limit).all()
    return jsonify(entries=[{"seq": r.seq, "at": r.at, "actor": r.actor, "action": r.action,
                             "detail": json.loads(r.detail), "hash": r.hash, "prev": r.prev_hash} for r in rows])


@bp.get("/api/activity/verify")
@login_required
def activity_verify():
    ok_, count, bad, head = audit.verify(T().id)
    return jsonify(ok=ok_, entries=count, firstBad=bad, head=head)


# ---------------------------------------------------------------- team
@bp.get("/api/users")
@login_required
def list_users():
    return jsonify(users=[{"id": u.id, "name": u.name, "email": u.email, "role": u.role, "active": u.active,
                           "lastLogin": u.last_login} for u in q(User).order_by(User.id)])


@bp.post("/api/users")
@login_required
@roles("admin")
def add_user():
    b = body()
    email = _clip(b.get("email"), 255).lower()
    name = _clip(b.get("name"), 200)
    role = b.get("role")
    pw = b.get("password") or ""
    if not name or "@" not in email:
        return err("Enter a name and a valid email.")
    if role not in ROLES:
        return err("Choose a role.")
    if len(pw) < 10:
        return err("Set a temporary password of at least 10 characters.")
    if User.query.filter_by(email=email).first():
        return err("That email already has an account.")
    db.session.add(User(tenant_id=T().id, email=email, name=name, role=role, password_hash=generate_password_hash(pw)))
    audit.log(T().id, actor(), "user.added", {"email": email, "role": role})
    db.session.commit()
    return list_users()


@bp.post("/api/users/<int:uid>")
@login_required
@roles("admin")
def update_user(uid):
    u = q(User).filter_by(id=uid).first()
    if not u:
        return err("Unknown user.", 404)
    b = body()
    if u.id == g.user.id:
        return err("You cannot change your own role or access.")
    if "role" in b:
        if b["role"] not in ROLES:
            return err("Choose a role.")
        u.role = b["role"]
    if "active" in b:
        u.active = bool(b["active"])
    audit.log(T().id, actor(), "user.updated", {"email": u.email, "role": u.role, "active": u.active})
    db.session.commit()
    return list_users()


# ---------------------------------------------------------------- demo
@bp.post("/api/demo/reset")
@login_required
@roles("admin")
def demo_reset():
    if not T().is_demo:
        return err("Only the demo workspace can be reset.", 403)
    reset_demo_tenant()
    audit.log(T().id, actor(), "demo.reset", {})
    return ok()
