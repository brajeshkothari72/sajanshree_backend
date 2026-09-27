// Maps a TallyPrime sales invoice to its WhatsApp message and records the outcome.
//
// Mirrors utils/orderNotifications.js, but for a different source of truth: an
// order is OUR document and we can mutate it freely, whereas an invoice belongs to
// Tally and we only keep a notification log beside it.

const TallyInvoice = require("../models/tallyInvoiceModel");
const { normalizeToWhatsAppNumber } = require("./phone");
const { sanitizeParam, MAX_ATTEMPTS } = require("./orderNotifications");
const { renderInvoicePdf } = require("./invoicePdf");
const { uploadInvoicePdf } = require("../config/cloudinary");
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

// The PDF template and the image template are separate approvals with different
// header types, so which one we use has to follow whether a PDF was produced.
// Falling back to the image template means a PDF failure still delivers the
// message — the customer gets their invoice details, just without the document.
function invoiceDocumentTemplateName() {
  return process.env.SLIDE_WHATSAPP_INVOICE_DOC_TEMPLATE || "invoice_with_document";
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

    const attempts = (invoice.whatsappNotification?.attempts || 0) + 1;

    // Attach the tax invoice when we have the line items to build one.
    //
    // Deliberately best-effort: if the PDF cannot be produced or uploaded, the
    // message still goes with the image template. A customer who gets their
    // invoice details without the attachment is far better served than one who
    // gets nothing because Cloudinary was briefly unreachable.
    let pdfUrl = null;
    if (Array.isArray(invoice.items) && invoice.items.length > 0) {
      try {
        const buffer = await renderInvoicePdf(invoice);
        const url = await uploadInvoicePdf(buffer, invoice.voucherGuid || invoice._id);

        // Uploading is not the same as being fetchable. Cloudinary blocks PDF
        // delivery by default ("Restricted media types"), so a perfectly good
        // upload can still answer 401 to anyone trying to read it — including
        // WhatsApp, which fetches the document itself. Sending a header pointing
        // at an unreadable URL fails the whole message, so confirm first and
        // fall back to the no-attachment template if it isn't public.
        const probe = await fetch(url, { signal: AbortSignal.timeout(15000) });
        const head = Buffer.from(await probe.arrayBuffer()).subarray(0, 5).toString();
        if (probe.ok && head === "%PDF-") {
          pdfUrl = url;
          console.log(`📄 Invoice PDF ready for ${invoice.voucherNumber} (${(buffer.length / 1024).toFixed(0)} KB)`);
        } else {
          console.error(
            `⚠️ PDF uploaded but is not publicly readable (HTTP ${probe.status}) for ` +
              `${invoice.voucherNumber} — sending without the attachment. ` +
              `Check Cloudinary → Settings → Security → Restricted media types.`
          );
        }
      } catch (error) {
        console.error(`⚠️ Could not attach PDF for ${invoice.voucherNumber}: ${error.message}`);
      }
    }

    const templateName = pdfUrl ? invoiceDocumentTemplateName() : invoiceTemplateName();

    console.log(
      `📤 Sending WhatsApp invoice notification for ${invoice.voucherNumber} (attempt ${attempts})...`
    );
    const result = await sendTemplateMessage({
      to: normalized.value,
      templateName,
      languageCode: whatsappConfig.languageCode,
      bodyParameters: buildInvoiceParams(invoice),
      // Meta rejects a send (132012) whose header parameter doesn't match the
      // template's declared header type, so these follow the template chosen above.
      ...(pdfUrl
        ? {
            headerDocumentUrl: pdfUrl,
            // What the customer sees when saving the file.
            headerDocumentFilename: `Invoice ${String(invoice.voucherNumber || "").replace(/[\\/:*?"<>|]/g, "-")}.pdf`,
          }
        : { headerImageUrl: whatsappConfig.headerImageUrl }),
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
  invoiceDocumentTemplateName,
  sendInvoiceNotification,
};
