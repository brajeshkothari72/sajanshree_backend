// Maps a TallyPrime sales invoice to its WhatsApp message and records the outcome.
//
// Mirrors utils/orderNotifications.js, but for a different source of truth: an
// order is OUR document and we can mutate it freely, whereas an invoice belongs to
// Tally and we only keep a notification log beside it.

const TallyInvoice = require("../models/tallyInvoiceModel");
const { normalizeToWhatsAppNumber } = require("./phone");
const { sanitizeParam, MAX_ATTEMPTS } = require("./orderNotifications");
const {
  isWhatsAppConfigured,
  sendTemplateMessage,
  whatsappConfig,
} = require("../config/whatsapp");

// The invoice template always carries the amount — unlike the order flow, where a
// checkbox picks between two templates. A bill the customer just paid has no
// version where hiding the value makes sense, so there is only one template here.
function invoiceTemplateName() {
  return process.env.SLIDE_WHATSAPP_INVOICE_TEMPLATE || "invoice_notification";
}

function formatAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "-";
  return amount.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * Positional parameters for the approved invoice template, in body order:
 *   {{1}} party name   {{2}} invoice number   {{3}} amount   {{4}} date
 * The "Rs." prefix lives in the approved template body, not in the parameter.
 */
function buildInvoiceParams(invoice) {
  // Full party name, not just the first word. This ledger is almost entirely
  // businesses, and "Hello Uniform," reads wrong for "Uniform House Billaspur".
  // sanitizeParam collapses the double spaces several party names carry.
  const greeting = String(invoice.partyLedgerName || "").trim() || "there";

  return [
    greeting,
    invoice.voucherNumber,
    formatAmount(invoice.amount),
    formatDate(invoice.voucherDate),
  ].map((text) => ({ type: "text", text: sanitizeParam(text) }));
}

/**
 * Send the WhatsApp notification for one stored invoice and persist the outcome.
 * Never throws — callers treat the returned object as the result.
 */
async function sendInvoiceNotification(invoiceId) {
  try {
    const invoice = await TallyInvoice.findById(invoiceId);
    if (!invoice) return { ok: false, status: "failed", message: "Invoice not found" };

    if (!isWhatsAppConfigured()) {
      await persist(invoice, { status: "disabled" });
      return { ok: false, status: "disabled", message: "WhatsApp is not configured" };
    }

    if (!invoice.partyPhone) {
      await persist(invoice, { status: "skipped_no_phone" });
      return { ok: false, status: "skipped_no_phone", message: "No phone number on this invoice" };
    }

    const normalized = normalizeToWhatsAppNumber(invoice.partyPhone);
    if (!normalized.ok) {
      await persist(invoice, { status: "skipped_invalid_phone", lastError: normalized.reason });
      return { ok: false, status: "skipped_invalid_phone", reason: normalized.reason };
    }

    const templateName = invoiceTemplateName();
    const attempts = (invoice.whatsappNotification?.attempts || 0) + 1;

    console.log(
      `📤 Sending WhatsApp invoice notification for ${invoice.voucherNumber} (attempt ${attempts})...`
    );
    const result = await sendTemplateMessage({
      to: normalized.value,
      templateName,
      languageCode: whatsappConfig.languageCode,
      bodyParameters: buildInvoiceParams(invoice),
      // The approved invoice template has an IMAGE header; Meta rejects the send
      // (132012) if it isn't supplied.
      headerImageUrl: whatsappConfig.headerImageUrl,
    });

    const base = {
      // Who we actually messaged, which differs while WHATSAPP_TEST_REDIRECT_TO
      // is set. The party's own number is already on the record, so storing
      // the truth here loses nothing.
      to: result.deliveredTo || normalized.value,
      templateName,
      languageCode: whatsappConfig.languageCode,
      attempts,
      lastAttemptAt: new Date(),
    };

    if (result.ok) {
      console.log(
        `✅ WhatsApp invoice notification sent for ${invoice.voucherNumber} (wamid: ${result.wamid})`
      );
      await persist(invoice, {
        ...base,
        status: "sent",
        wamid: result.wamid,
        conversationId: result.conversationId,
        sentAt: new Date(),
      });
    } else {
      console.error(
        `⚠️ WhatsApp invoice notification failed for ${invoice.voucherNumber}: ${result.message}`
      );
      await persist(invoice, {
        ...base,
        status: "failed",
        // A non-retryable failure is parked at the attempt cap so the cron sweep
        // stops hammering a bad key or an unapproved template.
        attempts: result.retryable ? attempts : MAX_ATTEMPTS,
        lastError: String(result.message || "").slice(0, 300),
        lastErrorCode: result.httpStatus || undefined,
      });
    }

    return result;
  } catch (error) {
    console.error("⚠️ sendInvoiceNotification error:", error.message);
    return { ok: false, status: "failed", message: error.message, retryable: true };
  }
}

// Atomic $set on one path — the caller has usually already responded to Tally by
// the time this runs, so a full save() could rewrite unrelated paths or race.
async function persist(invoice, notification) {
  await TallyInvoice.updateOne(
    { _id: invoice._id },
    { $set: { whatsappNotification: notification } }
  );
}

module.exports = {
  buildInvoiceParams,
  invoiceTemplateName,
  sendInvoiceNotification,
};
