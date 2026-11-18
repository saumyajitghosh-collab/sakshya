"""Evidence file storage. Files go in Postgres by default, or on a mounted disk when STORAGE_DIR is set."""
import hashlib
import os

from flask import current_app

from .extensions import db
from .models import Blob


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def store(evidence, data):
    """Attach bytes to an Evidence row that has been added to the session (flushed)."""
    root = current_app.config.get("STORAGE_DIR")
    if root:
        key = f"{evidence.tenant_id}/{evidence.sha256}"
        path = os.path.join(root, key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if not os.path.exists(path):
            tmp = path + ".tmp"
            with open(tmp, "wb") as fh:
                fh.write(data)
            os.replace(tmp, path)
        evidence.storage = "disk"
        evidence.storage_key = key
    else:
        db.session.add(Blob(evidence_id=evidence.id, data=data))
        evidence.storage = "db"
        evidence.storage_key = None


def load(evidence):
    if evidence.storage == "disk":
        root = current_app.config.get("STORAGE_DIR")
        with open(os.path.join(root, evidence.storage_key), "rb") as fh:
            return fh.read()
    if evidence.storage == "db":
        blob = Blob.query.filter_by(evidence_id=evidence.id).first()
        return blob.data if blob else None
    return None
