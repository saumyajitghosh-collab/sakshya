"""Data model. All timestamps are epoch milliseconds (UTC), matching the browser client."""
import time

from .extensions import db


def now_ms():
    return int(time.time() * 1000)


class Tenant(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(200), nullable=False)
    business = db.Column(db.String(200), default="")
    segment = db.Column(db.String(10), default="medium")  # large | medium | small (para 3)
    fy_type = db.Column(db.String(5), default="apr")  # apr | cal (para 36)
    contact = db.Column(db.String(200), default="")
    phone = db.Column(db.String(50), default="")
    auditor_id = db.Column(db.Integer, nullable=True)
    pricing = db.Column(db.JSON, default=dict)
    board_meeting = db.Column(db.BigInteger)
    board_dr = db.Column(db.BigInteger)
    board_backup = db.Column(db.BigInteger)
    board_bcp = db.Column(db.BigInteger)
    is_demo = db.Column(db.Boolean, default=False, nullable=False)
    created_at = db.Column(db.BigInteger, default=now_ms)


class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    tenant_id = db.Column(db.Integer, db.ForeignKey("tenant.id"), nullable=False, index=True)
    email = db.Column(db.String(255), unique=True, nullable=False)
    name = db.Column(db.String(200), nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(20), nullable=False, default="compliance")  # admin | compliance | auditor | viewer
    active = db.Column(db.Boolean, default=True, nullable=False)
    created_at = db.Column(db.BigInteger, default=now_ms)
    last_login = db.Column(db.BigInteger)


class ControlArea(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    tenant_id = db.Column(db.Integer, db.ForeignKey("tenant.id"), nullable=False, index=True)
    key = db.Column(db.String(20), nullable=False)
    name = db.Column(db.String(200), nullable=False)
    cadence = db.Column(db.String(1), nullable=False, default="m")  # m | q | h
    tod_required = db.Column(db.Integer, default=1)
    toe_source = db.Column(db.String(200), default="")
    owner = db.Column(db.String(120), default="")
    applicable = db.Column(db.Boolean, default=True, nullable=False)
    position = db.Column(db.Integer, default=0)
    __table_args__ = (db.UniqueConstraint("tenant_id", "key"),)


class Evidence(db.Model):
    """An artefact. Never deleted or overwritten; a replacement marks the old row superseded."""
    id = db.Column(db.Integer, primary_key=True)
    tenant_id = db.Column(db.Integer, db.ForeignKey("tenant.id"), nullable=False, index=True)
    area_id = db.Column(db.Integer, db.ForeignKey("control_area.id"), nullable=True, index=True)
    vendor_id = db.Column(db.Integer, db.ForeignKey("vendor.id"), nullable=True, index=True)
    kind = db.Column(db.String(30), nullable=False)  # tod | toe | vendor_assurance | vendor_devcert | vendor_cspaudit
    period = db.Column(db.String(40))
    name = db.Column(db.String(300), nullable=False)
    source = db.Column(db.String(200), default="")
    collected_at = db.Column(db.BigInteger, default=now_ms)
    sha256 = db.Column(db.String(64))
    status = db.Column(db.String(12), default="draft")  # draft | submitted | accepted
    filename = db.Column(db.String(300))
    content_type = db.Column(db.String(120))
    size = db.Column(db.Integer)
    storage = db.Column(db.String(8))  # db | disk | None (no file)
    storage_key = db.Column(db.String(300))
    uploaded_by = db.Column(db.String(255))
    superseded = db.Column(db.Boolean, default=False, nullable=False)


class Blob(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    evidence_id = db.Column(db.Integer, db.ForeignKey("evidence.id"), nullable=False, unique=True)
    data = db.Column(db.LargeBinary, nullable=False)


class Observation(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    tenant_id = db.Column(db.Integer, db.ForeignKey("tenant.id"), nullable=False, index=True)
    ref = db.Column(db.String(30), nullable=False)
    area_key = db.Column(db.String(20), nullable=False)
    title = db.Column(db.String(400), nullable=False)
    severity = db.Column(db.String(10), default="Medium")
    raised = db.Column(db.BigInteger, nullable=False)
    source = db.Column(db.String(120), default="System audit")
    status = db.Column(db.String(12), default="open")  # open | submitted | closed


class AuditorFirm(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    tenant_id = db.Column(db.Integer, db.ForeignKey("tenant.id"), nullable=False, index=True)
    name = db.Column(db.String(200), nullable=False)
    basis = db.Column(db.String(120), default="CERT-In empanelled")
    sisters = db.Column(db.JSON, default=list)


class ServiceRecord(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    tenant_id = db.Column(db.Integer, db.ForeignKey("tenant.id"), nullable=False, index=True)
    provider = db.Column(db.String(200), nullable=False)
    service = db.Column(db.String(300), default="")
    fy = db.Column(db.Integer, nullable=False)  # start year of the financial year


class Incident(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    tenant_id = db.Column(db.Integer, db.ForeignKey("tenant.id"), nullable=False, index=True)
    ref = db.Column(db.String(20), nullable=False)
    title = db.Column(db.String(300), nullable=False)
    cat = db.Column(db.String(80), nullable=False)
    cyber = db.Column(db.Boolean, default=False, nullable=False)
    detected = db.Column(db.BigInteger, nullable=False)  # immutable once set (para 22(d) clock)
    systems = db.Column(db.String(400), default="")
    impact = db.Column(db.JSON, default=dict)
    actions = db.Column(db.Text, default="")
    status = db.Column(db.String(200), default="Under investigation")
    window_pulled = db.Column(db.Boolean, default=False, nullable=False)
    narrative = db.Column(db.Text)
    ms = db.Column(db.JSON, default=dict)
    created_by = db.Column(db.String(255))
    __table_args__ = (db.UniqueConstraint("tenant_id", "ref"),)


class IncidentEvent(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    incident_id = db.Column(db.Integer, db.ForeignKey("incident.id"), nullable=False, index=True)
    at = db.Column(db.BigInteger, nullable=False)
    src = db.Column(db.String(24), default="LOG")
    text = db.Column(db.Text, nullable=False)


class Vendor(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    tenant_id = db.Column(db.Integer, db.ForeignKey("tenant.id"), nullable=False, index=True)
    name = db.Column(db.String(200), nullable=False)
    service = db.Column(db.String(300), default="")
    critical = db.Column(db.Boolean, default=True, nullable=False)
    agreement = db.Column(db.Boolean, default=False, nullable=False)
    assurance_to = db.Column(db.BigInteger)
    procured = db.Column(db.Boolean, default=False, nullable=False)
    source_obtained = db.Column(db.Boolean, default=False, nullable=False)
    escrow = db.Column(db.Boolean, default=False, nullable=False)
    dev_cert = db.Column(db.BigInteger)
    last_change = db.Column(db.BigInteger)
    cloud = db.Column(db.Boolean, default=False, nullable=False)
    csp_audit = db.Column(db.BigInteger)
    csp_board = db.Column(db.Boolean, default=False, nullable=False)


class BoardReport(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    tenant_id = db.Column(db.Integer, db.ForeignKey("tenant.id"), nullable=False, index=True)
    name = db.Column(db.String(300), nullable=False)
    by = db.Column(db.String(200), default="")
    received = db.Column(db.BigInteger, nullable=False)
    placed = db.Column(db.Boolean, default=False, nullable=False)


class ActivityLog(db.Model):
    """Append-only, hash-chained per tenant: each entry commits to the previous entry's hash."""
    id = db.Column(db.Integer, primary_key=True)
    tenant_id = db.Column(db.Integer, db.ForeignKey("tenant.id"), nullable=False, index=True)
    seq = db.Column(db.Integer, nullable=False)
    at = db.Column(db.BigInteger, nullable=False)
    actor = db.Column(db.String(255), nullable=False)
    action = db.Column(db.String(60), nullable=False)
    detail = db.Column(db.Text, nullable=False)  # canonical JSON
    prev_hash = db.Column(db.String(64), nullable=False)
    hash = db.Column(db.String(64), nullable=False)
    __table_args__ = (db.UniqueConstraint("tenant_id", "seq"),)
