const TallyInvoice = require("../models/tallyInvoiceModel");
const { sendInvoiceNotification } = require("../utils/invoiceNotifications");

// Tally writes dates as YYYYMMDD (e.g. 20260812), not ISO. Accept both so the
// companion service can forward whichever form it happens to have.
const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

function parseTallyDate(value) {
  if (!value) return null;
  const raw = String(value).trim();

  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (compact) {
    const [, y, m, d] = compact;
    // Construct in UTC: a local-time Date would shift the invoice a day backwards
    // for anyone running the server west of the shop.
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  }

  // Tally also sends "15-Sep-26" (observed from TDL on 15-Sep-2026). new Date()
  // parses that as LOCAL midnight, which lands a day early once stored as UTC.
  const dmyMatch = /^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/.exec(raw);
  if (dmyMatch) {
    const month = MONTHS[dmyMatch[2].toLowerCase()];
    if (month !== undefined) {
      let year = Number(dmyMatch[3]);
      if (year < 100) year += 2000;
      return new Date(Date.UTC(year, month, Number(dmyMatch[1])));
    }
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Does a repeat of the same voucher warrant messaging the customer again?
 *
 * "Material" means the bill the customer holds is now wrong: a different amount,
 * or a different number to reach them on. A changed voucher number is NOT
 * material — Auto Renumber shifts numbers whenever vouchers are inserted or
 * deleted, and re-saving a renumbered batch would message all those customers
 * again about purchases they already know about.
 *
 * Amounts are compared with a tolerance: they arrive as strings from Tally and
 * round-trip through Number, so an exact !== would resend on float noise alone.
 */
function describeChange(existing, incoming) {
  const amountChanged = Math.abs((existing.amount || 0) - (Number(incoming.amount) || 0)) > 0.005;
  const phoneChanged =
    String(incoming.partyPhone || "").trim() !== String(existing.partyPhone || "").trim();
  return { amountChanged, phoneChanged, material: amountChanged || phoneChanged };
}

/**
 * POST /api/tally/invoice-whatsapp
 *
 * Called by the local companion service on the shop PC after a sales voucher is
 * saved in TallyPrime.
 *
 * Contract with the companion, which is the whole point of this endpoint:
 *   2xx = "we own this invoice now, stop retrying."
 *   5xx = "we failed to store it, retry later."
 * The WhatsApp send is NOT part of that contract. It happens after the response,
 * and its failures are retried by our own cron sweep. If the send were awaited,
 * a Slide outage would surface as a 5xx, the companion would retry, and the
 * customer would get duplicate messages once Slide recovered.
 */
const createInvoiceNotification = async (req, res) => {
  try {
    const {
      voucherGuid,
      voucherNumber,
      voucherType,
      voucherDate,
      companyName,
      partyLedgerName,
      partyPhone,
      phoneCapturedAtBilling,
      sendToken,
      amount,
    } = req.body || {};

    const missing = ["voucherGuid", "voucherNumber", "partyLedgerName"].filter(
      (field) => !String(req.body?.[field] || "").trim()
    );
    if (missing.length) {
      return res.status(400).json({
        message: `Missing required field(s): ${missing.join(", ")}`,
      });
    }

    // Repeat handling, keyed on Tally's voucher GUID.
    //
    // What must be suppressed: TallyPrime fires the hook two or three times per
    // save (observed directly), and the companion retries on a flaky shop
    // connection. Left alone, every invoice would arrive two or three times and
    // each copy is billable.
    //
    // What must NOT be suppressed: the operator answering "Yes" in Tally. That is
    // an instruction, and a person who is told the message was queued must not
    // find that nothing happened. The companion stamps one token per
    // confirmation, so an unseen token means a human just asked — and we send.
    //
    // We also resend when the bill itself materially changed (amount or phone),
    // which covers a corrected invoice re-saved without anyone re-confirming.
    //
    // A changed voucher NUMBER is not a reason to resend: this company uses Auto
    // Renumber, so numbers shift whenever vouchers are inserted or deleted, and
    // re-saving a renumbered batch would message all those customers again about
    // purchases they already know about. The record is updated silently instead.
    const existing = await TallyInvoice.findOne({ voucherGuid: String(voucherGuid).trim() });
    if (existing) {
      const newAmount = Number(amount) || 0;
      const { amountChanged, phoneChanged, material } = describeChange(existing, {
        amount: newAmount,
        partyPhone,
      });
      const numberChanged = String(voucherNumber).trim() !== existing.voucherNumber;

      // The operator answering "Yes" in Tally is an instruction to send, and must
      // never be silently swallowed. The companion issues one token per
      // confirmation, so a token we have not acted on means a human just asked.
      // A repeat of a token we already sent is a retry and stays suppressed.
      const newConfirmation = Boolean(sendToken) && sendToken !== existing.lastSendToken;

      if (!material && !newConfirmation) {
        // Keep the record current even when nothing warrants a message.
        if (numberChanged) {
          await TallyInvoice.updateOne(
            { _id: existing._id },
            { $set: { voucherNumber: String(voucherNumber).trim() } }
          );
          console.log(
            `↻ ${existing.voucherNumber} renumbered to ${String(voucherNumber).trim()} — record updated, no resend`
          );
        }
        return res.status(200).json({
          message: "Already received",
          duplicate: true,
          invoiceId: existing._id,
          whatsapp: existing.whatsappNotification?.status || null,
        });
      }

      const why = newConfirmation
        ? "operator confirmed again"
        : `${amountChanged ? "amount changed " : ""}${phoneChanged ? "phone changed" : ""}`.trim();
      console.log(`✏️ ${existing.voucherNumber} — resending (${why})`);
      await TallyInvoice.updateOne(
        { _id: existing._id },
        {
          $set: {
            voucherNumber: String(voucherNumber).trim(),
            amount: newAmount,
            partyPhone,
            voucherDate: parseTallyDate(voucherDate) || existing.voucherDate,
            lastSendToken: sendToken,
          },
          // Clear the previous outcome so the sweep and the UI show this attempt,
          // not the one for the superseded bill.
          $unset: { whatsappNotification: "" },
        }
      );

      res.status(202).json({
        message: "Invoice updated, resending",
        invoiceId: existing._id,
        voucherNumber: String(voucherNumber).trim(),
        resent: true,
      });

      sendInvoiceNotification(existing._id).catch((error) =>
        console.error("⚠️ Background invoice notification failed:", error.message)
      );
      return;
    }

    let invoice;
    try {
      invoice = await TallyInvoice.create({
        voucherGuid: String(voucherGuid).trim(),
        voucherNumber: String(voucherNumber).trim(),
        voucherType: voucherType || "Sales",
        voucherDate: parseTallyDate(voucherDate),
        companyName,
        partyLedgerName: String(partyLedgerName).trim(),
        partyPhone,
        phoneCapturedAtBilling: Boolean(phoneCapturedAtBilling),
        amount: Number(amount) || 0,
        lastSendToken: sendToken,
      });
    } catch (error) {
      // Two identical posts can race past the findOne above. The unique index is
      // the real guard; this turns the collision into the same answer as a
      // sequential duplicate rather than a 500 the companion would retry forever.
      if (error.code === 11000) {
        const winner = await TallyInvoice.findOne({ voucherGuid: String(voucherGuid).trim() });
        return res.status(200).json({
          message: "Already received",
          duplicate: true,
          invoiceId: winner?._id,
        });
      }
      throw error;
    }

    // Respond before sending — see the contract note above.
    res.status(202).json({
      message: "Invoice received",
      invoiceId: invoice._id,
      voucherNumber: invoice.voucherNumber,
    });

    // Fire and forget. sendInvoiceNotification never throws, but .catch() guards
    // against an unhandled rejection taking the process down if that ever changes.
    sendInvoiceNotification(invoice._id).catch((error) =>
      console.error("⚠️ Background invoice notification failed:", error.message)
    );
  } catch (error) {
    console.error("❌ createInvoiceNotification error:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ message: "Failed to record invoice" });
    }
  }
};

/**
 * POST /api/tally/invoices/:id/whatsapp — manual resend for an admin.
 */
const resendInvoiceWhatsApp = async (req, res) => {
  try {
    const invoice = await TallyInvoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });

    const result = await sendInvoiceNotification(invoice._id);
    const refreshed = await TallyInvoice.findById(invoice._id).lean();

    return res.status(result.ok ? 200 : 422).json({
      message: result.ok ? "WhatsApp message sent" : "WhatsApp message not sent",
      whatsapp: refreshed?.whatsappNotification || null,
    });
  } catch (error) {
    console.error("❌ resendInvoiceWhatsApp error:", error.message);
    return res.status(500).json({ message: "Failed to resend" });
  }
};

module.exports = { createInvoiceNotification, resendInvoiceWhatsApp, parseTallyDate, describeChange };
