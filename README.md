# Sakshya

Control evidence for RBI-regulated non-bank payment system operators, built around the
Master Directions on Cyber Resilience and Digital Payment Security Controls for non-bank PSOs
of 5 November 2026 (RBI/DPSS/2026-27/475).

| Module | Paragraphs | What it does |
| --- | --- | --- |
| Audit Room | 36–41 | All 20 ¶38 control areas, design (TOD) and operating (TOE) evidence per period, readiness score, observations with the three-month corrective deadline, auditor-independence check against a services ledger, auditor evidence ZIP |
| Six-Hour Desk | 22(d) | Locked detection time, server-stamped filing stopwatch, log paste with timestamp and IP extraction, RBI and CERT-In drafts, optional Claude-drafted description |
| Vendor Flow-down | 5, 17(c), 18(b), 19(c), 26(c) | Vendor register with evidence expiry, escrow and developer-certificate rules, CSP audit review, vendor readiness request |
| Board Pack | 11, 12, 20(f), 23 | KRIs from live evidence, resilience-test calendar, IT assessment reports for the next meeting, sub-committee note |
| Activity log | – | Every change, hash-chained per workspace; one-click verification |

## Roles

- **Administrator**: everything, plus people and access.
- **Compliance**: uploads and submits evidence, runs incidents, manages vendors and the Board pack.
- **System auditor**: reads everything; the only role that can mark evidence as relied on or accept an observation's closure.
- **Board / viewer**: read only.

## Evidence integrity

- Files are hashed (SHA-256) on the server when uploaded and stored in Postgres (or on a mounted disk if `STORAGE_DIR` is set).
- Evidence is never edited or deleted. A replacement for the same period marks the earlier row as superseded.
- Every action writes an entry to a per-workspace hash chain: `sha256(prev_hash|tenant_id|seq|at_ms|actor|action|detail)`.
  The auditor ZIP includes the full chain and the rule, so it can be re-verified outside Sakshya.
- Incident detection time cannot be changed after the incident is opened; milestone times come from the server clock.

## Run locally

```bash
pip install -r requirements-dev.txt
export SECRET_KEY=dev SECURE_COOKIES=0
flask --app wsgi init-db        # creates tables and the shared demo workspace
flask --app wsgi run --debug
pytest -q
```

Without `DATABASE_URL` it uses SQLite (`sakshya.db`).

## Deploy on Render

`render.yaml` defines a Starter web service and a basic-256mb Postgres in Singapore.
In the Render dashboard: **New → Blueprint**, pick this repository, then set `ANTHROPIC_API_KEY`
if you want Claude to draft incident descriptions.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | SQLite file | Postgres connection string (`postgres://` is accepted) |
| `SECRET_KEY` | – | Session signing key; required on Render |
| `DEMO_MODE` | `1` | Creates the shared fictional demo workspace and shows its logins on the sign-in page |
| `DEMO_PASSWORD` | `sakshya-demo` | Password for the demo accounts |
| `ALLOW_SIGNUP` | `1` | Lets new PSOs create their own workspace |
| `ANTHROPIC_API_KEY` | – | Enables "Draft description with Claude" |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Model used for drafting |
| `STORAGE_DIR` | – | Store files on a mounted disk instead of Postgres |
| `MAX_UPLOAD_MB` | `25` | Upload size limit |
| `APP_TZ` | `Asia/Kolkata` | Time zone for financial-year and period boundaries |

`flask --app wsgi reset-demo` rebuilds the demo workspace.

## Not yet included

- Mapping of the RBI draft to the Annex 1 reporting spreadsheet's exact columns (done per client at onboarding).
- Real-time fraud scoring under ¶27(c); Sakshya records its alerts as evidence only.
- Database migrations (tables are created with `create_all`; add Alembic before changing the schema in production).
- An auditor login that spans several client workspaces.

All demo entities, people and figures are fictional.
