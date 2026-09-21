#!/usr/bin/env node
//
// Sajan Shree — TallyPrime WhatsApp companion service.
//
// Runs on the shop PC next to TallyPrime. TDL posts one invoice here when a sales
// voucher is saved; this process answers instantly, then forwards to the backend
// on its own time.
//
// WHY THIS EXISTS AT ALL
// TDL could call our HTTPS API directly. We don't, for two reasons:
//   1. Tally documents no timeout or async flag on its HTTP actions. A slow or
//      unreachable endpoint appears to block the voucher screen — meaning a
//      flaky shop connection would freeze the till mid-bill. Answering from
//      localhost in ~1ms makes that impossible.
//   2. There is nowhere safe in a plain-text TDL file to keep an API key, and no
//      retry story if the internet is down. Both live here instead.
//
// Deliberately ZERO npm dependencies: the till needs Node and nothing else, so
// deployment is "copy folder, run". Node 18+ for built-in fetch.

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

// ---------------------------------------------------------------- configuration

const CONFIG_PATH = process.env.TALLY_COMPANION_CONFIG || path.join(__dirname, "config.json");

function loadConfig() {
  let fileConfig = {};
  try {
    // Strip a leading BOM. This file gets hand-edited on a Windows till, and
    // PowerShell's Set-Content -Encoding utf8, Notepad and several editors all
    // write one; JSON.parse rejects it with an error that names an invisible
    // character, which is a miserable thing to debug on site.
    const text = fs.readFileSync(CONFIG_PATH, "utf8").replace(/^﻿/, "");
    fileConfig = JSON.parse(text);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`Could not parse ${CONFIG_PATH}: ${error.message}`);
      process.exit(1);
    }
  }

  const config = {
    port: Number(process.env.TALLY_COMPANION_PORT || fileConfig.port || 5111),
    apiBaseUrl: process.env.TALLY_API_BASE_URL || fileConfig.apiBaseUrl || "",
    apiKey: process.env.TALLY_API_KEY || fileConfig.apiKey || "",
    queueDir: fileConfig.queueDir || path.join(__dirname, "queue"),
    deadLetterDir: fileConfig.deadLetterDir || path.join(__dirname, "dead-letter"),
    logFile: fileConfig.logFile || path.join(__dirname, "companion.log"),
    pollIntervalMs: Number(fileConfig.pollIntervalMs || 15000),
    requestTimeoutMs: Number(fileConfig.requestTimeoutMs || 20000),
    maxAttempts: Number(fileConfig.maxAttempts || 12),
    tallyGatewayUrl: fileConfig.tallyGatewayUrl || "http://127.0.0.1:9000",
    tallyTimeoutMs: Number(fileConfig.tallyTimeoutMs || 20000),
  };

  // Only fatal when actually running the service. When this file is required by
  // a test to exercise the payload logic, missing config is irrelevant.
  if ((!config.apiBaseUrl || !config.apiKey) && require.main === module) {
    console.error(
      `Missing apiBaseUrl or apiKey. Set them in ${CONFIG_PATH} ` +
        `(copy config.example.json) or via TALLY_API_BASE_URL / TALLY_API_KEY.`
    );
    process.exit(1);
  }
  config.apiBaseUrl = config.apiBaseUrl.replace(/\/+$/, "");
  return config;
}

const config = loadConfig();

// ------------------------------------------------------------------------ logs

function log(level, message) {
  const line = `${new Date().toISOString()} ${level} ${message}`;
  console.log(line);
  // Append-only and best-effort: a full disk or a locked file must never stop us
  // accepting invoices from Tally.
  try {
    fs.appendFileSync(config.logFile, line + "\n");
  } catch {
    /* ignore */
  }
}

// ----------------------------------------------------------------- the payload
//
// TDL builds its request body from a Report, and the JSON that comes out is
// wrapped in the report/part/field structure rather than being the flat object we
// want. Rather than depend on a shape we haven't verified against a real Tally
// build yet, walk whatever arrives and pull the fields out by name.

const FIELD_ALIASES = {
  voucherGuid: ["voucherguid", "guid", "vchguid", "masterid"],
  voucherNumber: ["vouchernumber", "vchno", "voucherno", "invoiceno", "billno"],
  voucherType: ["vouchertype", "vchtype"],
  voucherDate: ["voucherdate", "date", "vchdate"],
  companyName: ["companyname", "company", "svcurrentcompany"],
  partyLedgerName: ["partyledgername", "partyname", "party", "ledgername"],
  partyPhone: ["partyphone", "mobile", "phone", "ledgermobile", "whatsappno"],
  phoneCapturedAtBilling: ["phonecapturedatbilling", "phonecaptured", "newnumber"],
  amount: ["amount", "total", "billamount", "invoiceamount"],
};

function flatten(node, into = new Map()) {
  if (node === null || typeof node !== "object") return into;
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, into);
    return into;
  }
  for (const [key, value] of Object.entries(node)) {
    if (value !== null && typeof value === "object") {
      flatten(value, into);
    } else {
      // First occurrence wins — TDL tends to emit the meaningful value before any
      // repeated/echoed copies further down the report.
      const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!into.has(k)) into.set(k, value);
    }
  }
  return into;
}

function normalizePayload(raw) {
  const flat = flatten(raw);
  const out = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      if (flat.has(alias) && String(flat.get(alias) ?? "").trim() !== "") {
        out[field] = flat.get(alias);
        break;
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------- disk queue
//
// Files on disk, not an in-memory array: the till gets switched off at closing
// time, and an invoice accepted at 8:59pm must still be sent tomorrow morning.

async function ensureDirs() {
  await fsp.mkdir(config.queueDir, { recursive: true });
  await fsp.mkdir(config.deadLetterDir, { recursive: true });
}

function safeName(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

// One operator "Yes" must always produce one message.
//
// TallyPrime fires the hook two or three times per confirmation (payload / empty
// body / payload, all within about a second), and those are mechanical, not a
// decision. A second genuine Yes — the operator deliberately asking again, maybe
// because the first message went to a wrong number — is a new instruction and
// must send.
//
// Everything within the window counts as one confirmation and gets one token;
// anything later is a new confirmation with a new token. The backend sends
// whenever the token is one it has not already acted on, so a human Yes is never
// swallowed while retries of the same job stay safe.
const CONFIRMATION_WINDOW_MS = 20000;
const recentConfirmations = new Map();

function confirmationToken(payload) {
  const key = [payload.voucherGuid, payload.amount, payload.partyPhone].join("|");
  const now = Date.now();

  for (const [k, seen] of recentConfirmations) {
    if (now - seen.at > CONFIRMATION_WINDOW_MS) recentConfirmations.delete(k);
  }

  const seen = recentConfirmations.get(key);
  if (seen) return { token: seen.token, repeat: true };

  const token = `${payload.voucherGuid || "vch"}:${now}`;
  recentConfirmations.set(key, { token, at: now });
  return { token, repeat: false };
}

async function enqueue(payload) {
  const job = {
    payload,
    attempts: 0,
    firstSeenAt: new Date().toISOString(),
    nextAttemptAt: 0,
  };
  const name = `${Date.now()}-${safeName(payload.voucherGuid || payload.voucherNumber)}.json`;
  const finalPath = path.join(config.queueDir, name);

  // Write to a temp name then rename: rename is atomic, so the worker can never
  // pick up a half-written file mid-flush.
  const tempPath = `${finalPath}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(job, null, 2), "utf8");
  await fsp.rename(tempPath, finalPath);
  return name;
}

// --------------------------------------------------------------- http listener

function readBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url.startsWith("/health")) {
    const queued = await fsp.readdir(config.queueDir).catch(() => []);
    return json(res, 200, {
      ok: true,
      queued: queued.filter((f) => f.endsWith(".json")).length,
      apiBaseUrl: config.apiBaseUrl,
    });
  }

  if (req.method !== "POST" || !req.url.startsWith("/enqueue")) {
    return json(res, 404, { ok: false, message: "Not found" });
  }

  try {
    const rawText = await readBody(req);

    // TallyPrime fires more than one request per HTTP Request action — observed
    // as payload / empty / payload. The empty one is not an error and must not
    // be logged as one, or the log is three-quarters noise.
    if (!rawText.trim()) {
      return json(res, 204, { ok: true, ignored: "empty body" });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseError) {
      // Dump the exact bytes. TallyPrime's JSON output has to be taken as found,
      // not as documented, and a truncated log line is useless for diagnosing it.
      const dump = path.join(__dirname, "last-bad-body.txt");
      try {
        fs.writeFileSync(
          dump,
          `${new Date().toISOString()}\n` +
            `parse error: ${parseError.message}\n` +
            `byte length: ${Buffer.byteLength(rawText)}\n` +
            `--- raw body follows ---\n${rawText}`
        );
      } catch {
        /* ignore */
      }
      log(
        "WARN",
        `Rejected non-JSON body (${Buffer.byteLength(rawText)} bytes): ` +
          `${parseError.message} — full body written to ${dump}`
      );
      return json(res, 400, { ok: false, message: "Body must be JSON" });
    }

    const payload = normalizePayload(parsed);
    const missing = ["voucherGuid", "voucherNumber", "partyLedgerName"].filter(
      (field) => !String(payload[field] || "").trim()
    );
    if (missing.length) {
      log("WARN", `Rejected payload missing ${missing.join(", ")}: ${rawText.slice(0, 300)}`);
      return json(res, 400, { ok: false, message: `Missing: ${missing.join(", ")}` });
    }

    // Stamp this confirmation. Tally's repeats within the window share a token;
    // a later Yes gets a new one and therefore always sends.
    const { token, repeat } = confirmationToken(payload);
    if (repeat) {
      log("INFO", `Ignoring Tally's repeat fire for ${payload.voucherNumber}`);
      return json(res, 200, { ok: true, duplicate: true });
    }
    payload.sendToken = token;

    const name = await enqueue(payload);
    log("INFO", `Queued ${payload.voucherNumber} for ${payload.partyLedgerName} as ${name}`);

    // Answer immediately. Tally is blocked on this response, so nothing slow may
    // happen before it — the forward to the backend is the worker's job.
    json(res, 200, { ok: true, queued: true });
    setImmediate(() => drain().catch(() => {}));
  } catch (error) {
    log("ERROR", `Enqueue failed: ${error.message}`);
    json(res, 500, { ok: false, message: error.message });
  }
});

// --------------------------------------------------- enrichment from Tally
//
// TDL cannot produce the invoice total. $Amount is not a method on the Voucher
// object — the value lives on the ledger entries — and four TDL expressions all
// returned empty. So ask Tally's XML gateway instead, which hands back the
// party's own entry directly. Verified 15-Sep-2026 against voucher
// 2026-27/No397: party entry -5355.00, matching the printed invoice.
//
// This runs in the WORKER, never at enqueue time. At enqueue Tally is blocked
// waiting for our response, and its gateway does not answer while the UI is
// busy — we watched a modal dialog wedge it completely during development.
//
// The date comes from here too: the gateway returns a clean YYYYMMDD, whereas
// TDL's date string parsed as local time and landed a day out on a UTC server.

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function enrichFromTally(payload) {
  const guid = String(payload.voucherGuid || "").trim();
  if (!guid) return null;

  const body = `<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>VchByGuid</ID></HEADER>
<BODY><DESC><STATICVARIABLES>
<SVEXPORTFORMAT>$SysName:XML</SVEXPORTFORMAT>
<SVCURRENTCOMPANY>${xmlEscape(payload.companyName || "")}</SVCURRENTCOMPANY>
</STATICVARIABLES>
<TDL><TDLMESSAGE>
<COLLECTION NAME="VchByGuid" ISINITIALIZE="Yes">
<TYPE>Voucher</TYPE><NATIVEMETHOD>LedgerEntries</NATIVEMETHOD><FILTER>ThisGuid</FILTER>
</COLLECTION>
<SYSTEM TYPE="Formulae" NAME="ThisGuid">$Guid = "${xmlEscape(guid)}"</SYSTEM>
</TDLMESSAGE></TDL>
</DESC></BODY></ENVELOPE>`;

  let xml;
  try {
    const r = await fetch(config.tallyGatewayUrl, {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body,
      signal: AbortSignal.timeout(config.tallyTimeoutMs),
    });
    xml = await r.text();
  } catch (error) {
    log("WARN", `Tally gateway unreachable for ${payload.voucherNumber}: ${error.message}`);
    return null;
  }

  // The party's own row is the single entry flagged IsPartyLedger, and Tally
  // stores it negative on a sale.
  let amount = null;
  for (const block of xml.split("<LEDGERENTRIES.LIST>").slice(1)) {
    if (!/<ISPARTYLEDGER[^>]*>\s*Yes/i.test(block)) continue;
    const m = /<AMOUNT[^>]*>([^<]*)/.exec(block);
    if (m) amount = Math.abs(Number(String(m[1]).trim()));
    break;
  }
  const dateMatch = /<DATE[^>]*>\s*(\d{8})/.exec(xml);

  if (!Number.isFinite(amount) || amount === null) {
    log("WARN", `Tally returned no party amount for ${payload.voucherNumber}`);
    return null;
  }
  return { amount, voucherDate: dateMatch ? dateMatch[1] : payload.voucherDate };
}

// -------------------------------------------------------------------- worker

let draining = false;

async function forward(job) {
  const response = await fetch(`${config.apiBaseUrl}/api/tally/invoice-whatsapp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": config.apiKey,
    },
    body: JSON.stringify(job.payload),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  const text = await response.text().catch(() => "");
  return { status: response.status, text };
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    const names = (await fsp.readdir(config.queueDir).catch(() => []))
      .filter((name) => name.endsWith(".json"))
      .sort();

    for (const name of names) {
      const filePath = path.join(config.queueDir, name);
      let job;
      try {
        job = JSON.parse(await fsp.readFile(filePath, "utf8"));
      } catch {
        continue; // being written, or corrupt — the next pass will see it
      }
      if (Date.now() < (job.nextAttemptAt || 0)) continue;

      job.attempts += 1;

      // An invoice with no total would message the customer "Rs. 0.00", which is
      // worse than sending nothing — so this is a retry, not a degraded send.
      if (!Number(job.payload.amount)) {
        const extra = await enrichFromTally(job.payload);
        if (extra) {
          job.payload = { ...job.payload, ...extra };
          log("INFO", `Enriched ${job.payload.voucherNumber} from Tally: amount=${extra.amount}`);
        } else {
          const delay = Math.min(10 * 60_000, 5000 * 2 ** (job.attempts - 1));
          job.nextAttemptAt = Date.now() + delay;
          await fsp.writeFile(filePath, JSON.stringify(job, null, 2), "utf8").catch(() => {});
          log("WARN", `No amount for ${job.payload.voucherNumber}; retrying in ${Math.round(delay / 1000)}s`);
          continue;
        }
      }

      let outcome;
      try {
        outcome = await forward(job);
      } catch (error) {
        outcome = { status: 0, text: error.message };
      }

      // 2xx means the backend owns it now — including its 200 "already received",
      // which is how a retry of an invoice we already sent resolves. Deleting on
      // 2xx is what stops a duplicate WhatsApp message.
      if (outcome.status >= 200 && outcome.status < 300) {
        await fsp.unlink(filePath).catch(() => {});
        log("INFO", `Sent ${job.payload.voucherNumber} (HTTP ${outcome.status})`);
        continue;
      }

      // 4xx other than 429 is our own bad payload. Retrying can't fix it, so park
      // it for a human rather than looping until maxAttempts.
      const permanent =
        outcome.status >= 400 && outcome.status < 500 && outcome.status !== 429;
      if (permanent || job.attempts >= config.maxAttempts) {
        await fsp
          .rename(filePath, path.join(config.deadLetterDir, name))
          .catch(() => {});
        log(
          "ERROR",
          `Dead-lettered ${job.payload.voucherNumber} after ${job.attempts} attempt(s): ` +
            `HTTP ${outcome.status} ${outcome.text.slice(0, 200)}`
        );
        continue;
      }

      // Exponential backoff, capped at 10 minutes so an overnight outage still
      // clears promptly once the connection returns.
      const delay = Math.min(10 * 60_000, 5000 * 2 ** (job.attempts - 1));
      job.nextAttemptAt = Date.now() + delay;
      await fsp.writeFile(filePath, JSON.stringify(job, null, 2), "utf8").catch(() => {});
      log(
        "WARN",
        `Retry ${job.payload.voucherNumber} in ${Math.round(delay / 1000)}s ` +
          `(attempt ${job.attempts}, HTTP ${outcome.status})`
      );
    }
  } finally {
    draining = false;
  }
}

// ---------------------------------------------------------------------- start

async function main() {
  await ensureDirs();

  // 127.0.0.1 only, never 0.0.0.0. The sole client is TDL on this same machine,
  // and binding wider would expose an unauthenticated enqueue endpoint to the
  // shop LAN — anyone on the wifi could send WhatsApp messages as the business.
  server.listen(config.port, "127.0.0.1", () => {
    log("INFO", `Companion listening on http://127.0.0.1:${config.port}`);
    log("INFO", `Forwarding to ${config.apiBaseUrl}`);
  });

  setInterval(() => drain().catch(() => {}), config.pollIntervalMs);
  await drain().catch(() => {});
}

// Only start when run directly, so the payload logic above can be unit tested
// by requiring this file without binding a port or spawning timers.
if (require.main === module) {
  main().catch((error) => {
    log("ERROR", `Fatal: ${error.stack || error.message}`);
    process.exit(1);
  });
}

module.exports = { normalizePayload, flatten, confirmationToken, CONFIRMATION_WINDOW_MS };
