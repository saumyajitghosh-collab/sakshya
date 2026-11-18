"""Tamper-evident activity log: a per-tenant SHA-256 hash chain."""
import hashlib
import json

from .extensions import db
from .models import ActivityLog, Tenant, now_ms

GENESIS = "0" * 64


def _canonical(detail):
    return json.dumps(detail or {}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _digest(prev, tenant_id, seq, at, actor, action, detail_str):
    payload = f"{prev}|{tenant_id}|{seq}|{at}|{actor}|{action}|{detail_str}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def log(tenant_id, actor, action, detail=None):
    """Append an entry inside the caller's transaction. The tenant row lock serialises writers on Postgres."""
    db.session.query(Tenant).filter_by(id=tenant_id).with_for_update().first()
    last = (
        ActivityLog.query.filter_by(tenant_id=tenant_id)
        .order_by(ActivityLog.seq.desc())
        .first()
    )
    seq = (last.seq + 1) if last else 1
    prev = last.hash if last else GENESIS
    at = now_ms()
    d = _canonical(detail)
    entry = ActivityLog(
        tenant_id=tenant_id, seq=seq, at=at, actor=actor, action=action, detail=d,
        prev_hash=prev, hash=_digest(prev, tenant_id, seq, at, actor, action, d),
    )
    db.session.add(entry)
    return entry


def verify(tenant_id):
    """Recompute the chain. Returns (ok, count, first_bad_seq or None, head_hash)."""
    prev = GENESIS
    count = 0
    for e in ActivityLog.query.filter_by(tenant_id=tenant_id).order_by(ActivityLog.seq.asc()).yield_per(500):
        count += 1
        if e.seq != count or e.prev_hash != prev:
            return False, count, e.seq, prev
        if _digest(prev, tenant_id, e.seq, e.at, e.actor, e.action, e.detail) != e.hash:
            return False, count, e.seq, prev
        prev = e.hash
    return True, count, None, prev
