// Seller details printed on the invoice PDF.
//
// Configuration, not code: a wrong GSTIN on a tax invoice is a compliance
// problem, and whoever needs to correct it should not need a deploy to do it.
// Every value can be overridden by an environment variable.
//
// The letterhead artwork already carries the address, phone numbers and email,
// so those are deliberately NOT repeated in the body of the invoice.

const path = require("path");

const company = {
  legalName: process.env.COMPANY_LEGAL_NAME || "Sajan Shree Garments",

  // Verified 27-Sep-2026: checksum valid, state code 23 = Madhya Pradesh,
  // which matches the Indore address on the letterhead.
  gstin: process.env.COMPANY_GSTIN || "23AMAPK7262L1ZZ",
  // Characters 3-12 of a GSTIN are the PAN, so it never needs storing twice.
  get pan() {
    return process.env.COMPANY_PAN || String(this.gstin).slice(2, 12);
  },
  stateName: process.env.COMPANY_STATE || "Madhya Pradesh",
  stateCode: process.env.COMPANY_STATE_CODE || "23",

  // NOTE: the letterhead artwork prints ssgbhavya@gmail.com. This is the address
  // to actually use, so the invoice shows both — worth having the letterhead
  // reprinted so a customer is not left guessing which one reaches you.
  email: process.env.COMPANY_EMAIL || "ssgbhavya@rediffmail.com",

  bank: {
    name: process.env.COMPANY_BANK_NAME || "State Bank of India",
    branch: process.env.COMPANY_BANK_BRANCH || "Mill Area, Indore",
    accountName: process.env.COMPANY_BANK_AC_NAME || "Sajanshree Garments",
    accountNumber: process.env.COMPANY_BANK_AC_NO || "41662720974",
    ifsc: process.env.COMPANY_BANK_IFSC || "SBIN0030019",
  },

  // Pre-rendered artwork rather than drawn text. PDFKit has no OpenType shaping,
  // so Devanagari drawn as text comes out with broken conjuncts and misplaced
  // matras — सजनश्री गारमेन्ट्स would be unreadable. The existing letterhead is
  // already typeset correctly, so it goes on as an image.
  letterheadPath: process.env.COMPANY_LETTERHEAD || path.join(__dirname, "..", "assets", "letterhead.png"),

  terms:
    process.env.COMPANY_INVOICE_TERMS ||
    "Goods once sold will not be taken back. Subject to Indore jurisdiction.",
};

// Brand palette, taken from the printed letterhead and the dashboard theme.
const brand = {
  navy: "#1B2F5E",
  red: "#A81E24",
  green: "#2E7D63",
  ink: "#1F2937",
  muted: "#6B7280",
  rule: "#D9DEE7",
  band: "#F1F5F9",
};

module.exports = { company, brand };
