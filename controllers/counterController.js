// The dispatch-slip counter: what the phone asks for, and what the till does
// about it.
//
// Three audiences, three auth schemes, and they must not be confused:
//   - the owner, on a JWT session, creating and revoking devices
//   - a registered counter device, on its cookie, doing the day's work
//   - the till companion, on the shared TALLY_API_KEY, collecting work to do

const { CounterDevice, DispatchSlip, TillCommand, TillSnapshot } = require("../models/counterModels");
const { setDeviceCookie, newSecret } = require("../middleware/counterAuthMiddleware");

const INVITE_TTL_MS = 30 * 60 * 1000;
const MAX_SLIP_BYTES = 8 * 1024 * 1024;

// --- owner, on a JWT session -------------------------------------------------

// Create a single-use link that registers whatever phone opens it.
async function createInvite(req, res) {
  const label = String(req.body?.label || "").trim() || "Counter phone";
  const code = newSecret();

  await CounterDevice.create({
    label,
    inviteCode: code,
    inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
  });

  // Built from the request rather than configuration, so it is right on every
  // host this runs on without another environment variable to get wrong.
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  res.status(201).json({
    label,
    url: `${base}/slips/claim/${code}`,
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    // Said plainly because the owner is about to send this to someone.
    note: "Open this on the phone once, within 30 minutes. It works a single time.",
  });
}

async function listDevices(req, res) {
  const devices = await CounterDevice.find().sort({ createdAt: -1 }).limit(50);
  res.json(
    devices.map((d) => ({
      id: d._id,
      label: d.label,
      status: d.revokedAt ? "revoked" : d.deviceToken ? "active" : "invited",
      claimedAt: d.claimedAt,
      lastSeenAt: d.lastSeenAt,
      userAgent: d.userAgent,
      inviteExpired: Boolean(d.inviteExpiresAt && d.inviteExpiresAt < new Date() && !d.deviceToken),
    }))
  );
}

async function revokeDevice(req, res) {
  const device = await CounterDevice.findById(req.params.id);
  if (!device) return res.status(404).json({ message: "No such device" });

  // The token goes as well as the flag. Revocation has to mean the credential
  // no longer exists, not merely that we currently decline to honour it.
  device.revokedAt = new Date();
  device.deviceToken = undefined;
  device.inviteCode = undefined;
  await device.save();

  res.json({ ok: true, label: device.label });
}

// --- the phone, claiming its invite ------------------------------------------

// Opened by following the invite link. Plants the cookie and sends the phone on
// to the page, so the person sees the bills and not a confirmation screen.
// Opened by following the invite link. Shows a page with ONE tap to confirm,
// rather than registering the device on this GET itself.
//
// That used to be the whole handler, and it meant WhatsApp's own
// link-preview crawler could burn a single-use invite before the person it
// was sent to ever saw it - observed in practice: a link shared in a WhatsApp
// chat was claimed nine seconds later by "WhatsApp/2.23.20.0", not a phone.
// A crawler fetches a page; it does not submit a form, so gating the actual
// registration behind a POST closes that off.
async function showClaimPage(req, res) {
  const device = await CounterDevice.findOne({ inviteCode: req.params.code });

  if (!device || device.revokedAt) {
    return res.status(410).send(claimFailed("This link has already been used, or was cancelled."));
  }
  if (device.inviteExpiresAt && device.inviteExpiresAt < new Date()) {
    return res.status(410).send(claimFailed("This link has expired. Ask for a new one."));
  }

  res.send(claimPrompt(device.label, req.params.code));
}

// The tap. Registers the device, plants the cookie, sends the phone on to
// the page it will actually use.
async function confirmClaim(req, res) {
  const device = await CounterDevice.findOne({ inviteCode: req.params.code });

  if (!device || device.revokedAt) {
    return res.status(410).send(claimFailed("This link has already been used, or was cancelled."));
  }
  if (device.inviteExpiresAt && device.inviteExpiresAt < new Date()) {
    return res.status(410).send(claimFailed("This link has expired. Ask for a new one."));
  }

  device.deviceToken = newSecret();
  device.inviteCode = undefined; // single use
  device.inviteExpiresAt = undefined;
  device.claimedAt = new Date();
  device.userAgent = String(req.get("user-agent") || "").slice(0, 300);
  await device.save();

  setDeviceCookie(res, device.deviceToken);
  res.redirect("/slips");
}

function claimFailed(message) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link not usable</title>
<body style="font:17px/1.5 system-ui,sans-serif;margin:0;padding:40px 24px;color:#1F2937">
<h1 style="font-size:20px;color:#A81E24;margin:0 0 10px">Link not usable</h1>
<p>${message}</p></body>`;

// A minimal page with exactly one real control: a form, which only a human
// tapping it will submit. A link-preview crawler fetches this and stops here.
function claimPrompt(label, code) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Set up this phone</title>
<body style="font:17px/1.5 system-ui,sans-serif;margin:0;padding:40px 24px;color:#1F2937;text-align:center">
<h1 style="font-size:20px;color:#1B2F5E;margin:0 0 10px">${label}</h1>
<p>This will remember this phone for the dispatch slip page. Do this on the phone that will actually be used at the counter.</p>
<form method="POST" action="/slips/claim/${code}">
<button type="submit" style="margin-top:16px;width:100%;max-width:320px;padding:16px;font-size:17px;font-weight:700;color:#fff;background:#1B2F5E;border:0;border-radius:12px;">Set up this phone</button>
</form>
</body>`;
}
}

// --- the phone, doing the day's work -----------------------------------------

// The bill list the till last pushed up.
//
// Served from the snapshot rather than asked of Tally, which is what lets this
// page stay useful with the till switched off: the last known bills, labelled
// with when they were read, instead of a blank screen.
async function bills(req, res) {
  const snapshot = await TillSnapshot.findOne({ key: "bills" });
  const list = snapshot?.bills || [];

  // Slip state is answered here, not stored on the snapshot: the till does not
  // know about slips any more, and the till is not the authority on them.
  const slips = await DispatchSlip.find(
    { voucherNumber: { $in: list.map((b) => b.voucherNumber) } },
    "voucherNumber usedAt"
  );
  const byVoucher = new Map(slips.map((s) => [s.voucherNumber, s]));

  res.json({
    at: snapshot?.at || null,
    bills: list.map((b) => {
      const slip = byVoucher.get(b.voucherNumber);
      return { ...b, slip: slip ? { state: slip.usedAt ? "sent" : "waiting" } : null };
    }),
  });
}

async function uploadSlip(req, res) {
  const voucherNumber = String(req.body?.voucherNumber || "").trim();
  const base64 = String(req.body?.base64 || "");
  if (!voucherNumber) return res.status(400).json({ message: "Which bill is this slip for?" });
  if (!base64) return res.status(400).json({ message: "No photo received." });
  if (Buffer.byteLength(base64, "base64") > MAX_SLIP_BYTES) {
    return res.status(413).json({ message: "That photo is over 8 MB." });
  }

  // Replacing is the normal case, not an error: the first photo was blurred, or
  // the wrong slip was on the counter.
  await DispatchSlip.findOneAndUpdate(
    { voucherNumber },
    {
      voucherNumber,
      imageBase64: base64,
      contentType: req.body?.contentType === "image/png" ? "image/png" : "image/jpeg",
      uploadedByDevice: req.counterDevice?._id,
      usedAt: null,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  res.status(201).json({ ok: true, voucherNumber });
}

async function slipImage(req, res) {
  const slip = await DispatchSlip.findOne({ voucherNumber: String(req.query.v || "").trim() });
  if (!slip) return res.status(404).json({ message: "No slip on that bill." });

  const bytes = Buffer.from(slip.imageBase64, "base64");
  res.writeHead(200, {
    "Content-Type": slip.contentType,
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
  });
  res.end(bytes);
}

// Ask the till to send one. Nothing is checked against Tally here - the till is
// the only thing that can do that, and it may well be switched off right now.
async function requestSend(req, res) {
  const voucherNumber = String(req.body?.voucherNumber || "").trim();
  const partyLedgerName = String(req.body?.partyLedgerName || "").trim();
  if (!voucherNumber || !partyLedgerName) {
    return res.status(400).json({ message: "Need the bill number and the party." });
  }

  // A second tap, or a double tap, must not become a second message. An
  // outstanding request for the same bill is the same request.
  const outstanding = await TillCommand.findOne({
    type: "send",
    voucherNumber,
    status: { $in: ["pending", "claimed"] },
  });
  if (outstanding) {
    return res.json({ ok: true, duplicate: true, status: outstanding.status });
  }

  await TillCommand.create({
    type: "send",
    voucherNumber,
    partyLedgerName,
    requestedByDevice: req.counterDevice?._id,
  });

  res.status(202).json({ ok: true });
}

// What became of a request, so the page can say "sent" rather than "probably".
async function sendStatus(req, res) {
  const command = await TillCommand.findOne({ type: "send", voucherNumber: String(req.query.v || "").trim() })
    .sort({ createdAt: -1 });
  if (!command) return res.json({ status: "none" });
  res.json({ status: command.status, error: command.error, completedAt: command.completedAt });
}

// --- the till companion, on the shared key -----------------------------------

async function putSnapshot(req, res) {
  const list = Array.isArray(req.body?.bills) ? req.body.bills : [];
  await TillSnapshot.findOneAndUpdate(
    { key: "bills" },
    { key: "bills", bills: list, at: new Date() },
    { upsert: true }
  );
  res.json({ ok: true, bills: list.length });
}

// Hand out pending work. Claimed in one atomic update each, so two companions -
// or one restarted mid-poll - cannot both take the same job and send twice.
async function claimCommands(req, res) {
  const out = [];
  for (let i = 0; i < 5; i += 1) {
    const command = await TillCommand.findOneAndUpdate(
      { status: "pending" },
      { $set: { status: "claimed", claimedAt: new Date() } },
      { sort: { createdAt: 1 }, new: true }
    );
    if (!command) break;
    out.push({
      id: command._id,
      type: command.type,
      voucherNumber: command.voucherNumber,
      partyLedgerName: command.partyLedgerName,
    });
  }
  res.json(out);
}

async function completeCommand(req, res) {
  const ok = req.body?.ok !== false;
  const command = await TillCommand.findByIdAndUpdate(
    req.params.id,
    {
      $set: {
        status: ok ? "done" : "failed",
        completedAt: new Date(),
        error: ok ? undefined : String(req.body?.error || "").slice(0, 300),
      },
    },
    { new: true }
  );
  if (!command) return res.status(404).json({ message: "No such command" });

  // A failed send must not mark the slip as used, or the page would claim the
  // customer has it when nobody does.
  if (ok) {
    await DispatchSlip.updateOne(
      { voucherNumber: command.voucherNumber, usedAt: null },
      { $set: { usedAt: new Date() } }
    );
  }
  res.json({ ok: true });
}

module.exports = {
  createInvite,
  listDevices,
  revokeDevice,
  showClaimPage,
  confirmClaim,
  bills,
  uploadSlip,
  slipImage,
  requestSend,
  sendStatus,
  putSnapshot,
  claimCommands,
  completeCommand,
};
