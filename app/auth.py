"""Sign-in, sign-up, sessions, roles and CSRF."""
import secrets
import time
from collections import defaultdict
from functools import wraps

from flask import (Blueprint, abort, current_app, g, jsonify, redirect, render_template, request, session,
                   url_for)
from werkzeug.security import check_password_hash, generate_password_hash

from . import audit
from .extensions import db
from .models import Tenant, User, now_ms
from .seed import DEMO_USERS, create_tenant, seed_demo_content

bp = Blueprint("auth", __name__)

ROLES = ("admin", "compliance", "auditor", "viewer")
EDITORS = ("admin", "compliance")

_failures = defaultdict(list)  # (ip, email) -> [timestamps]; per-process throttle
MAX_FAILS, WINDOW = 5, 15 * 60


def _throttled(key):
    now = time.time()
    _failures[key] = [t for t in _failures[key] if now - t < WINDOW]
    return len(_failures[key]) >= MAX_FAILS


def csrf_token():
    tok = session.get("csrf")
    if not tok:
        tok = session["csrf"] = secrets.token_urlsafe(24)
    return tok


def _check_form_csrf():
    tok = request.form.get("csrf")
    if not tok or tok != session.get("csrf"):
        abort(400, "Your session expired. Reload the page and try again.")


@bp.app_context_processor
def inject():
    return {"csrf_token": csrf_token}


def load_user():
    uid = session.get("uid")
    if not uid:
        return None
    user = db.session.get(User, uid)
    if not user or not user.active or session.get("tid") != user.tenant_id:
        session.clear()
        return None
    return user


def login_required(view):
    @wraps(view)
    def wrapped(*a, **kw):
        user = load_user()
        if not user:
            if request.path.startswith("/api/"):
                return jsonify(error="Sign in again."), 401
            return redirect(url_for("auth.login", next=request.path))
        g.user = user
        g.tenant = db.session.get(Tenant, user.tenant_id)
        if request.path.startswith("/api/") and request.method not in ("GET", "HEAD"):
            # CSRF: browsers cannot send a custom header cross-site without a CORS preflight, which we never allow.
            if request.headers.get("X-Sakshya") != "1":
                return jsonify(error="Missing request header."), 400
        return view(*a, **kw)
    return wrapped


def roles(*allowed):
    def deco(view):
        @wraps(view)
        def wrapped(*a, **kw):
            if g.user.role not in allowed:
                return jsonify(error="Your role cannot do this."), 403
            return view(*a, **kw)
        return wrapped
    return deco


def _start_session(user):
    session.clear()
    session.permanent = True
    session["uid"] = user.id
    session["tid"] = user.tenant_id
    csrf_token()
    user.last_login = now_ms()


@bp.route("/login", methods=["GET", "POST"])
def login():
    if load_user():
        return redirect(url_for("api.app_shell"))
    error = None
    email = ""
    if request.method == "POST":
        _check_form_csrf()
        email = (request.form.get("email") or "").strip().lower()
        password = request.form.get("password") or ""
        key = (request.headers.get("X-Forwarded-For", request.remote_addr or "").split(",")[0], email)
        if _throttled(key):
            error = "Too many failed attempts. Wait 15 minutes and try again."
        else:
            user = User.query.filter_by(email=email).first()
            if user and user.active and check_password_hash(user.password_hash, password):
                _failures.pop(key, None)
                _start_session(user)
                audit.log(user.tenant_id, user.email, "auth.sign_in", {"role": user.role})
                db.session.commit()
                nxt = request.args.get("next") or ""
                return redirect(nxt if nxt.startswith("/") and not nxt.startswith("//") else url_for("api.app_shell"))
            _failures[key].append(time.time())
            error = "That email and password don't match an active account."
    demo = None
    if current_app.config["DEMO_MODE"]:
        demo = {"password": current_app.config["DEMO_PASSWORD"], "users": DEMO_USERS}
    return render_template("login.html", error=error, email=email, demo=demo,
                           allow_signup=current_app.config["ALLOW_SIGNUP"], pay_url=current_app.config.get("PAYMENT_URL"))


@bp.route("/signup", methods=["GET", "POST"])
def signup():
    if not current_app.config["ALLOW_SIGNUP"]:
        abort(404)
    error = None
    form = request.form if request.method == "POST" else {}
    if request.method == "POST":
        _check_form_csrf()
        org = (form.get("org") or "").strip()
        name = (form.get("name") or "").strip()
        email = (form.get("email") or "").strip().lower()
        password = form.get("password") or ""
        segment = form.get("segment") if form.get("segment") in ("large", "medium", "small") else "medium"
        fy_type = form.get("fy_type") if form.get("fy_type") in ("apr", "cal") else "apr"
        if not org or not name or "@" not in email:
            error = "Enter your organisation, your name and a valid work email."
        elif len(password) < 10:
            error = "Use a password of at least 10 characters."
        elif User.query.filter_by(email=email).first():
            error = "An account with that email already exists. Sign in instead."
        else:
            tenant = create_tenant(org, segment=segment, fy_type=fy_type, business=(form.get("business") or "").strip(),
                                   contact=name)
            user = User(tenant_id=tenant.id, email=email, name=name, role="admin",
                        password_hash=generate_password_hash(password))
            db.session.add(user)
            db.session.flush()
            audit.log(tenant.id, email, "workspace.created", {"segment": segment, "fy_type": fy_type})
            if form.get("sample") == "1":
                business = tenant.business
                seed_demo_content(tenant)
                tenant.contact = name
                tenant.business = business or tenant.business
            _start_session(user)
            db.session.commit()
            return redirect(url_for("api.app_shell"))
    return render_template("signup.html", error=error, form=form)


@bp.post("/logout")
def logout():
    user = load_user()
    _check_form_csrf()
    if user:
        audit.log(user.tenant_id, user.email, "auth.sign_out", {})
        db.session.commit()
    session.clear()
    return redirect(url_for("auth.login"))
