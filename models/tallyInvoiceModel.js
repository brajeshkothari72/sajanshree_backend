const mongoose = require("mongoose");
const whatsappNotificationSchema = require("./whatsappNotificationSchema");

// One sales invoice pushed to us from TallyPrime, and the WhatsApp message we
// sent for it. This is a NOTIFICATION LOG, not a copy of the books — Tally stays
// the system of record for accounting. We keep only what the message needs plus
// enough context for an admin to work out why a send failed.
const tallyInvoiceSchema = new mongoose.Schema(
  {
    // Tally's own voucher GUID ($Guid). Globally unique and stable across edits,
    // which makes it the idempotency key: the companion service retries on a
    // flaky shop connection, and without this a retry would message the customer
    // twice for one invoice.
    voucherGuid: { type: String, required: true, unique: true, index: true },

    // Voucher number as printed on the bill ("SS/2026-27/309"). NOT unique —
    // Tally numbering restarts each financial year and is per voucher type.
    voucherNumber: { type: String, required: true, trim: true },
    voucherType: { type: String, trim: true, default: "Sales" },
    voucherDate: { type: Date },

    companyName: { type: String, trim: true },

    // Party ledger name exactly as it appears in Tally. This is the join key back
    // to the books, so it is stored verbatim — no casing or whitespace fixes.
    partyLedgerName: { type: String, required: true, trim: true },

    // Snapshot of the number at send time, as Tally supplied it. Never re-read
    // from the ledger later: the ledger can be altered afterwards, and the log
    // must keep showing the number we actually messaged.
    partyPhone: { type: String, trim: true },
    // True when the operator typed the number into the Tally prompt rather than
    // it already being on the ledger. Lets us audit the write-back path.
    phoneCapturedAtBilling: { type: Boolean, default: false },

    amount: { type: Number },

    // The companion issues one token per operator confirmation in Tally. We
    // store the last one we actually sent for, so a repeat of the same token
    // (a retry) stays quiet while a fresh Yes always sends.
    lastSendToken: { type: String },

    whatsappNotification: { type: whatsappNotificationSchema, default: undefined },
  },
  { timestamps: true }
);

const TallyInvoice = mongoose.model("TallyInvoice", tallyInvoiceSchema);
module.exports = TallyInvoice;
