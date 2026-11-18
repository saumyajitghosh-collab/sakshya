"""Sakshya: control evidence for RBI-regulated non-bank payment system operators."""
import os
from datetime import timedelta

import click
from flask import Flask, jsonify
from werkzeug.middleware.proxy_fix import ProxyFix

from .extensions import db


def _database_url():
    url = os.environ.get("DATABASE_URL", "sqlite:///sakshya.db")
    # Render and Heroku hand out postgres:// URLs; SQLAlchemy with psycopg 3 wants postgresql+psycopg://
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://"):]
    elif url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


def create_app(test_config=None):
    app = Flask(__name__)
    secret = os.environ.get("SECRET_KEY")
    app.config.update(
        SECRET_KEY=secret or "dev-only-change-me",
        SQLALCHEMY_DATABASE_URI=_database_url(),
        SQLALCHEMY_ENGINE_OPTIONS={"pool_pre_ping": True},
        MAX_CONTENT_LENGTH=int(os.environ.get("MAX_UPLOAD_MB", "25")) * 1024 * 1024,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=os.environ.get("SECURE_COOKIES", "1") == "1",
        PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
        STORAGE_DIR=os.environ.get("STORAGE_DIR") or None,
        ALLOW_SIGNUP=os.environ.get("ALLOW_SIGNUP", "1") == "1",
        DEMO_MODE=os.environ.get("DEMO_MODE", "1") == "1",
        DEMO_PASSWORD=os.environ.get("DEMO_PASSWORD", "sakshya-demo"),
        ANTHROPIC_API_KEY=os.environ.get("ANTHROPIC_API_KEY") or None,
        ANTHROPIC_MODEL=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5"),
        APP_TZ=os.environ.get("APP_TZ", "Asia/Kolkata"),
    )
    if test_config:
        app.config.update(test_config)
    if not secret and not app.config.get("TESTING") and os.environ.get("RENDER"):
        raise RuntimeError("SECRET_KEY must be set in production")

    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
    db.init_app(app)

    from . import models  # noqa: F401  (register tables)
    from .auth import bp as auth_bp
    from .api import bp as api_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(api_bp)

    @app.get("/healthz")
    def healthz():
        try:
            db.session.execute(db.text("select 1"))
            return jsonify(ok=True)
        except Exception:  # pragma: no cover
            return jsonify(ok=False), 503

    @app.after_request
    def security_headers(resp):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        resp.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src https://fonts.gstatic.com; img-src 'self' data: blob:; "
            "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        )
        if app.config["SESSION_COOKIE_SECURE"]:
            resp.headers.setdefault("Strict-Transport-Security", "max-age=31536000")
        return resp

    @app.errorhandler(413)
    def too_large(_e):
        return jsonify(error=f"File is larger than the {os.environ.get('MAX_UPLOAD_MB', '25')} MB limit."), 413

    @app.cli.command("init-db")
    def init_db():
        """Create tables and, in demo mode, the shared demo workspace."""
        db.create_all()
        if app.config["DEMO_MODE"]:
            from .seed import ensure_demo_tenant
            t = ensure_demo_tenant()
            click.echo(f"Demo workspace ready: {t.name}")
        click.echo("Database ready.")

    @app.cli.command("reset-demo")
    def reset_demo_cmd():
        """Rebuild the shared demo workspace from scratch."""
        from .seed import reset_demo_tenant
        reset_demo_tenant()
        click.echo("Demo workspace reset.")

    return app
