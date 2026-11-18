"""Financial-year and period helpers (para 36), evaluated in the app's time zone (IST by default)."""
from datetime import datetime
from zoneinfo import ZoneInfo

from flask import current_app


def tz():
    try:
        return ZoneInfo(current_app.config.get("APP_TZ", "Asia/Kolkata"))
    except Exception:
        return ZoneInfo("Asia/Kolkata")


def to_dt(ms):
    return datetime.fromtimestamp(ms / 1000, tz())


def ms_of(y, m, d=1):
    """Epoch ms for local midnight; month m is 1-based and may overflow."""
    y += (m - 1) // 12
    m = (m - 1) % 12 + 1
    return int(datetime(y, m, d, tzinfo=tz()).timestamp() * 1000)


def fy_of(ms, fy_type):
    d = to_dt(ms)
    if fy_type == "cal":
        return {"sy": d.year, "start": ms_of(d.year, 1), "end": ms_of(d.year + 1, 1), "label": f"CY {d.year}"}
    sy = d.year if d.month >= 4 else d.year - 1
    return {"sy": sy, "start": ms_of(sy, 4), "end": ms_of(sy + 1, 4), "label": f"FY {sy}-{str(sy + 1)[2:]}"}


def fy_label(sy, fy_type):
    return f"CY {sy}" if fy_type == "cal" else f"FY {sy}-{str(sy + 1)[2:]}"


MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"]


def periods_for(fy, cad):
    length = {"m": 1, "q": 3, "h": 6}[cad]
    start = to_dt(fy["start"])
    out = []
    for i in range(0, 12, length):
        a = ms_of(start.year, start.month + i)
        b = ms_of(start.year, start.month + i + length)
        n = i // length
        if cad == "m":
            d = to_dt(a)
            key = f"{d.year}-{d.month:02d}"
            label = f"{MONTHS[d.month - 1]} {d.year}"
        else:
            key = f"{fy['label']} {'Q' if cad == 'q' else 'H'}{n + 1}"
            label = key
        out.append({"key": key, "label": label, "start": a, "end": b, "n": n})
    return out


def add_months(ms, n):
    d = to_dt(ms)
    m = d.month - 1 + n
    y = d.year + m // 12
    m = m % 12 + 1
    day = min(d.day, 28)
    return int(d.replace(year=y, month=m, day=day).timestamp() * 1000)
