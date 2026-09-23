# TallyPrime → WhatsApp companion

Runs on the shop PC beside TallyPrime. A TDL add-on posts one sales invoice here
when the operator asks for it; this service forwards it to the backend, which
sends the WhatsApp message via Slide.

```
TallyPrime ──HTTP──▶ companion ──HTTPS──▶ backend ──▶ Slide ──▶ Meta ──▶ customer
           127.0.0.1:5111        /api/tally/invoice-whatsapp
```

## Why this process exists

TDL could call the backend directly. It doesn't, for two reasons:

1. **Tally documents no timeout on its HTTP actions.** A slow or unreachable
   endpoint appears to block the voucher screen, so a flaky shop connection would
   freeze the till mid-bill. Answering from localhost in ~1 ms makes that
   impossible. (We saw a related failure during development: a modal dialog in
   Tally's UI wedges its HTTP gateway entirely.)
2. **A plain-text TDL file is no place for an API key**, and TDL has no retry
   story if the internet is down. Both live here instead.

## Install

Needs **Node 18+** (uses built-in `fetch`). Nothing else — zero npm dependencies,
so there is no `npm install` step on the till.

```powershell
copy config.example.json config.json
# edit config.json: apiBaseUrl + apiKey
powershell -ExecutionPolicy Bypass -File .\install-service.ps1
```

`install-service.ps1` registers a Task Scheduler job that starts at logon and
restarts on failure. It **refuses to install** if `config.json` still points at
localhost or carries a placeholder key — that mistake looks like success in
testing and silently sends nothing in production.

To remove: `.\install-service.ps1 -Uninstall`

## Configuration

| Key | Meaning |
|---|---|
| `port` | Local listen port. Bound to `127.0.0.1` only — never `0.0.0.0`, or anyone on the shop wifi could send WhatsApp messages as the business. |
| `apiBaseUrl` | Backend root, no trailing slash. |
| `apiKey` | Must match `TALLY_API_KEY` in the backend `.env`. |
| `pollIntervalMs` | How often the queue drains. Default 15 s. |
| `requestTimeoutMs` | Per-request timeout to the backend. Default 20 s. |
| `maxAttempts` | Retries before dead-lettering. Default 12. |

`config.json` is gitignored — it holds a live key.

## How delivery works

`POST /enqueue` writes the invoice to `queue/` and answers immediately. A worker
drains the queue in the background.

- **2xx from the backend** — including its `200 "already received"` — means the
  backend owns it. The file is deleted. This is what prevents duplicate messages
  when a retry lands on an invoice already sent.
- **4xx (except 429)** is a bad payload. Retrying can't fix it, so the file moves
  to `dead-letter/` for a human rather than looping.
- **5xx, 429, or a network failure** retries with exponential backoff, capped at
  10 minutes so an overnight outage clears promptly next morning.

The queue is **files on disk, not memory**: the till gets switched off at closing
time, and an invoice accepted at 8:59 pm must still send tomorrow.

Note the division of responsibility — the companion retries *transport to the
backend*; the backend retries *the WhatsApp send* via its own cron sweep. Neither
retries the other's job, which is why a Slide outage can't cause duplicates.

## Operations

```powershell
# is it alive, and how much is waiting?
# NOT `curl` - in PowerShell that is an alias for Invoke-WebRequest, which stops
# to ask about parsing the response. Invoke-RestMethod just returns the JSON.
Invoke-RestMethod http://127.0.0.1:5111/health

# what has it been doing?
Get-Content .\companion.log -Tail 50

# what failed permanently?
Get-ChildItem .\dead-letter\

# start it by hand (it also starts at logon via the Startup folder)
Start-Process node -ArgumentList companion.js -WorkingDirectory $PWD -WindowStyle Hidden
```

**No response from the health check means the companion is down**, TDL is posting
into a closed port, and Tally shows the operator nothing at all. This is the first
thing to check when invoices stop arriving.

A file in `dead-letter/` contains the original payload and the attempt count.
Fix the cause, then move it back into `queue/` to retry it.

## Gotchas found the hard way

- **TallyPrime fires more than one request per `HTTP Request` action** — observed
  as payload / empty body / payload. Empty bodies are ignored; duplicates are
  collapsed by the backend's unique index on the voucher GUID.
- **TDL wraps the request report** as `{"ENVELOPE":{"<XML Tag>":{...}}}` rather
  than sending a flat object, so the payload parser flattens whatever arrives and
  matches fields by name at any depth.
- **`queue/` and `dead-letter/` hold real customer phone numbers.** Both are
  gitignored. Treat them as personal data when copying logs off the machine.
