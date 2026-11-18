"""Claude drafts the Description field of the para 22(d) report from recorded facts and evidence only."""
from datetime import datetime

from flask import current_app

from .periods import tz


def _fmt(ms):
    return datetime.fromtimestamp(ms / 1000, tz()).strftime("%d %b %Y, %H:%M")


def build_prompt(tenant, inc, events):
    imp = inc.impact or {}
    ev = "\n".join(f"{_fmt(e.at)} | {e.src} | {e.text}" for e in events[:200])
    return (
        "You are drafting the \"Description\" field of an initial incident report that a non-bank payment system "
        "operator in India files with the Reserve Bank of India within six hours of detection (para 22(d), Master "
        "Directions RBI/DPSS/2026-27/475).\n"
        "Write one paragraph of at most 170 words in plain, past-tense regulatory English. Use only the facts and "
        "evidence below. Do not speculate about attribution or root cause; say \"under investigation\" where a fact "
        "is missing. Give the date once, then 24-hour times. Use Indian number formatting for rupee amounts. Return "
        "only the paragraph, with no heading.\n\n"
        f"FACTS\nEntity: {tenant.name} ({tenant.business})\nIncident: {inc.title}\nCategory: {inc.cat}\n"
        f"Detected: {_fmt(inc.detected)} (IST)\nSystems affected: {inc.systems or 'unknown'}\n"
        f"Impact: {imp.get('customers', 0)} customers, {imp.get('txns', 0)} transactions, Rs {imp.get('value', 0)}\n"
        f"Actions taken:\n{inc.actions or 'none recorded'}\nStatus: {inc.status or ''}\n\n"
        f"EVIDENCE (time | source | line)\n{ev}"
    )


def draft_description(tenant, inc, events):
    from anthropic import Anthropic

    client = Anthropic(api_key=current_app.config["ANTHROPIC_API_KEY"], timeout=60)
    msg = client.messages.create(
        model=current_app.config["ANTHROPIC_MODEL"],
        max_tokens=700,
        messages=[{"role": "user", "content": build_prompt(tenant, inc, events)}],
    )
    text = "".join(getattr(b, "text", "") for b in msg.content if getattr(b, "type", "") == "text").strip()
    if not text:
        raise RuntimeError("empty response")
    return text[:5000]
