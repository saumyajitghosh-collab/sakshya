import io
import json
import re
import zipfile

import pytest

from app import create_app
from app.extensions import db
from app.models import ActivityLog, Evidence, Incident, Tenant, User
from app.seed import ensure_demo_tenant

H = {"X-Sakshya": "1"}


@pytest.fixture()
def app(tmp_path):
    app = create_app({"TESTING": True, "SQLALCHEMY_DATABASE_URI": f"sqlite:///{tmp_path}/t.db",
                      "SESSION_COOKIE_SECURE": False, "DEMO_PASSWORD": "demo-pass-123", "ANTHROPIC_API_KEY": None})
    with app.app_context():
        db.create_all()
        ensure_demo_tenant()
    yield app


def csrf(client, path="/login"):
    html = client.get(path).get_data(as_text=True)
    return re.search(r'name="csrf" value="([^"]+)"', html).group(1)


def login(client, email, pw="demo-pass-123"):
    tok = csrf(client)
    r = client.post("/login", data={"csrf": tok, "email": email, "password": pw})
    assert r.status_code == 302, r.get_data(as_text=True)[:300]


def state(client):
    r = client.get("/api/state")
    assert r.status_code == 200
    return r.get_json()["state"]


def test_login_required_and_bad_password(app):
    c = app.test_client()
    assert c.get("/api/state").status_code == 401
    assert c.get("/").status_code == 302
    tok = csrf(c)
    r = c.post("/login", data={"csrf": tok, "email": "admin@kestrel.demo", "password": "wrong"})
    assert b"don&#39;t match" in r.data or b"don't match" in r.data


def test_demo_state_shape(app):
    c = app.test_client()
    login(c, "admin@kestrel.demo")
    s = state(c)
    assert len(s["areas"]) == 20
    assert s["areas"][0]["name"] == "Information Security Governance"
    assert s["areas"][-1]["name"] == "Mobile Online Services"
    assert any(i["id"] == "INC-0412" and not i["ms"].get("rbi") for i in s["incidents"])
    assert s["me"]["role"] == "admin" and s["isDemo"] is True


def test_csrf_header_required(app):
    c = app.test_client()
    login(c, "admin@kestrel.demo")
    r = c.post("/api/board/test", json={"k": "dr"})
    assert r.status_code == 400
    assert c.post("/api/board/test", json={"k": "dr"}, headers=H).status_code == 200


def test_upload_hash_and_download(app):
    c = app.test_client()
    login(c, "compliance@kestrel.demo")
    payload = b"policy text v1"
    r = c.post("/api/evidence", headers=H, data={"area": "dev", "kind": "tod", "name": "", "source": "Policy library",
                                                 "file": (io.BytesIO(payload), "mdm-policy.pdf")},
               content_type="multipart/form-data")
    assert r.status_code == 200, r.get_json()
    import hashlib
    assert r.get_json()["sha256"] == hashlib.sha256(payload).hexdigest()
    dev = [a for a in r.get_json()["state"]["areas"] if a["id"] == "dev"][0]
    item = dev["tod"][-1]
    assert item["name"] == "mdm-policy.pdf" and item["hasFile"]
    got = c.get(f"/api/evidence/{item['id']}/file")
    assert got.data == payload


def test_toe_replacement_supersedes_not_deletes(app):
    c = app.test_client()
    login(c, "compliance@kestrel.demo")
    s = state(c)
    acc = [a for a in s["areas"] if a["id"] == "data"][0]
    period = acc["toe"][0]["period"]
    before = Evidence.query.count() if False else None  # noqa
    r = c.post("/api/evidence", headers=H, data={"area": "data", "kind": "toe", "period": period, "name": "Redo",
                                                 "file": (io.BytesIO(b"x"), "x.csv")}, content_type="multipart/form-data")
    assert r.status_code == 200
    with app.app_context():
        rows = Evidence.query.filter_by(period=period, kind="toe").all()
        rows = [e for e in rows if e.area_id and e.name in ("Redo",) or e.superseded]
        assert any(e.superseded for e in rows) and any(e.name == "Redo" and not e.superseded for e in rows)


def test_only_auditor_can_rely_on_evidence(app):
    comp, aud = app.test_client(), app.test_client()
    login(comp, "compliance@kestrel.demo")
    login(aud, "auditor@kestrel.demo")
    s = state(comp)
    sub = [x for a in s["areas"] for x in a["tod"] + a["toe"] if x["status"] == "submitted"][0]
    r = comp.post(f"/api/evidence/{sub['id']}/status", json={"status": "accepted"}, headers=H)
    assert r.status_code == 403
    r = aud.post(f"/api/evidence/{sub['id']}/status", json={"status": "accepted"}, headers=H)
    assert r.status_code == 200
    # the auditor cannot edit incidents
    assert aud.patch("/api/incidents/INC-0412", json={"status": "x"}, headers=H).status_code == 403


def test_observation_closure_needs_auditor(app):
    comp, aud = app.test_client(), app.test_client()
    login(comp, "compliance@kestrel.demo")
    login(aud, "auditor@kestrel.demo")
    assert comp.post("/api/observations/OBS-26-03/status", json={"status": "submitted"}, headers=H).status_code == 200
    assert comp.post("/api/observations/OBS-26-03/status", json={"status": "closed"}, headers=H).status_code == 403
    r = aud.post("/api/observations/OBS-26-03/status", json={"status": "closed"}, headers=H)
    assert r.status_code == 200
    assert [o for o in r.get_json()["state"]["obs"] if o["id"] == "OBS-26-03"][0]["status"] == "closed"


def test_viewer_is_read_only(app):
    c = app.test_client()
    login(c, "board@kestrel.demo")
    assert c.post("/api/board/test", json={"k": "dr"}, headers=H).status_code == 403
    assert c.get("/api/export/evidence.zip").status_code == 200


def test_detection_time_locked_and_server_milestones(app):
    c = app.test_client()
    login(c, "compliance@kestrel.demo")
    r = c.patch("/api/incidents/INC-0412", json={"detected": 1}, headers=H)
    assert r.status_code == 409
    r = c.post("/api/incidents/INC-0412/milestone", json={"key": "rbi"}, headers=H)
    inc = [i for i in r.get_json()["state"]["incidents"] if i["id"] == "INC-0412"][0]
    assert inc["ms"]["rbi"] - inc["detected"] < 6 * 3_600_000
    assert c.post("/api/incidents/INC-0412/milestone", json={"key": "rbi"}, headers=H).status_code == 409


def test_open_incident_parses_logs(app):
    c = app.test_client()
    login(c, "compliance@kestrel.demo")
    import time
    det = int(time.time() * 1000) - 60_000
    r = c.post("/api/incidents", headers=H, json={
        "title": "Settlement delay", "cat": "Settlement delay", "cyber": False, "detected": det, "systems": "Batch",
        "logs": "[SIEM] 2026-11-18T09:41:07+05:30 blocked 12 requests from 203.0.113.9\nplain line"})
    assert r.status_code == 200
    ref = r.get_json()["ref"]
    inc = [i for i in r.get_json()["state"]["incidents"] if i["id"] == ref][0]
    assert len(inc["events"]) == 2 and inc["events"][0]["src"] in ("SIEM", "LOG")
    assert any(e["src"] == "SIEM" and "203.0.113.9" in e["text"] for e in inc["events"])
    future = int(time.time() * 1000) + 3_600_000
    assert c.post("/api/incidents", headers=H, json={"title": "x", "cat": "Settlement delay", "detected": future}).status_code == 400


def test_tenant_isolation(app):
    c = app.test_client()
    tok = csrf(c, "/signup")
    r = c.post("/signup", data={"csrf": tok, "org": "Other PSO Ltd", "name": "Asha", "email": "asha@other.example",
                                "password": "long-enough-pw", "segment": "small", "fy_type": "apr"})
    assert r.status_code == 302
    s = state(c)
    assert s["entity"] == "Other PSO Ltd" and s["incidents"] == [] and s["vendors"] == []
    with app.app_context():
        demo_ev = Evidence.query.join(Tenant, Tenant.id == Evidence.tenant_id).filter(Tenant.is_demo.is_(True)).first().id
    assert c.get(f"/api/evidence/{demo_ev}/file").status_code == 404
    assert c.post("/api/observations/OBS-26-03/status", json={"status": "submitted"}, headers=H).status_code == 404
    assert c.patch("/api/incidents/INC-0412", json={"status": "x"}, headers=H).status_code == 404


def test_activity_chain_detects_tampering(app):
    c = app.test_client()
    login(c, "admin@kestrel.demo")
    c.post("/api/board/test", json={"k": "dr"}, headers=H)
    v = c.get("/api/activity/verify").get_json()
    assert v["ok"] and v["entries"] >= 3
    with app.app_context():
        e = ActivityLog.query.order_by(ActivityLog.seq).offset(1).first()
        e.detail = json.dumps({"tampered": True})
        db.session.commit()
    v = c.get("/api/activity/verify").get_json()
    assert not v["ok"] and v["firstBad"] == 2


def test_auditor_independence_data_and_zip(app):
    c = app.test_client()
    login(c, "admin@kestrel.demo")
    r = c.get("/api/export/evidence.zip")
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.data))
    names = z.namelist()
    assert "manifest.csv" in names and "activity-log.json" in names and any(n.startswith("files/") for n in names)
    pack = json.loads(z.read("manifest.json"))
    assert pack["activity_log"]["chain_intact"] is True
    # every stored file's name embeds its own hash prefix, and that hash matches the bytes
    import hashlib
    for n in names:
        if n.startswith("files/"):
            data = z.read(n)
            prefix = n.rsplit("/", 1)[1].split("_")[-2] if n.count("_") >= 2 else n.rsplit("/", 1)[1].split("_")[0]
            assert hashlib.sha256(data).hexdigest().startswith(prefix[:12]) or hashlib.sha256(data).hexdigest()[:12] in n


def test_vendor_devcert_rule(app):
    c = app.test_client()
    login(c, "compliance@kestrel.demo")
    s = state(c)
    tessera = [v for v in s["vendors"] if v["name"].startswith("Tessera")][0]
    old = tessera["lastChange"] - 86_400_000
    r = c.post(f"/api/vendors/{tessera['id']}/fix", headers=H, data={"fix": "devcert", "date": str(old)},
               content_type="multipart/form-data")
    assert r.status_code == 400
    import time
    r = c.post(f"/api/vendors/{tessera['id']}/fix", headers=H,
               data={"fix": "devcert", "date": str(int(time.time() * 1000)), "file": (io.BytesIO(b"cert"), "cert.pdf")},
               content_type="multipart/form-data")
    assert r.status_code == 200
    t2 = [v for v in r.get_json()["state"]["vendors"] if v["id"] == tessera["id"]][0]
    assert t2["devCert"] >= t2["lastChange"] and t2["docs"][-1]["hasFile"]


def test_admin_user_management(app):
    c = app.test_client()
    login(c, "admin@kestrel.demo")
    r = c.post("/api/users", headers=H, json={"name": "New Auditor", "email": "na@firm.example", "role": "auditor",
                                              "password": "temporary-123"})
    assert r.status_code == 200 and any(u["email"] == "na@firm.example" for u in r.get_json()["users"])
    c2 = app.test_client()
    login(c2, "compliance@kestrel.demo")
    assert c2.post("/api/users", headers=H, json={"name": "x", "email": "x@y.z", "role": "admin", "password": "aaaaaaaaaaaa"}).status_code == 403


def test_demo_reset(app):
    c = app.test_client()
    login(c, "admin@kestrel.demo")
    c.post("/api/incidents/INC-0412/milestone", json={"key": "rbi"}, headers=H)
    r = c.post("/api/demo/reset", json={}, headers=H)
    assert r.status_code == 200
    inc = [i for i in r.get_json()["state"]["incidents"] if i["id"] == "INC-0412"][0]
    assert "rbi" not in inc["ms"]
    assert c.get("/api/activity/verify").get_json()["ok"]
