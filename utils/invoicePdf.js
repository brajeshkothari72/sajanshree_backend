// Renders a branded copy of a Tally sales invoice as a PDF.
//
// PDFKit rather than a headless browser: Render's free tier has 512 MB and cold
// starts, and Chromium would make both materially worse for a document this
// simple. The cost is no HTML/CSS and no complex text shaping — which is why the
// Devanagari letterhead is placed as artwork rather than drawn as text.
//
// The figures come from Tally and are NOT recomputed here. If items and tax do
// not reconcile to the party total, that is reported rather than quietly
// corrected: a customer holding a copy whose arithmetic disagrees with the books
// is worse than one holding no copy at all.

const PDFDocument = require("pdfkit");
const fs = require("fs");
const { company, brand } = require("../config/company");

const PAGE_MARGIN = 36;
const money = (n) =>
  Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Indian numbering, which is what the customer's accountant expects to read.
function amountInWords(value) {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  const two = (n) => (n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? " " + ones[n % 10] : ""}`);
  const three = (n) =>
    n >= 100 ? `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? " " + two(n % 100) : ""}` : two(n);

  const whole = Math.floor(Math.abs(Number(value) || 0));
  const paise = Math.round((Math.abs(Number(value) || 0) - whole) * 100);
  if (whole === 0 && paise === 0) return "Zero Rupees Only";

  const parts = [];
  const crore = Math.floor(whole / 10000000);
  const lakh = Math.floor((whole % 10000000) / 100000);
  const thousand = Math.floor((whole % 100000) / 1000);
  const rest = whole % 1000;
  if (crore) parts.push(`${three(crore)} Crore`);
  if (lakh) parts.push(`${three(lakh)} Lakh`);
  if (thousand) parts.push(`${three(thousand)} Thousand`);
  if (rest) parts.push(three(rest));

  let words = parts.join(" ") + " Rupees";
  if (paise) words += ` and ${two(paise)} Paise`;
  return words + " Only";
}

// Explicit month names rather than toLocaleDateString: Node's en-IN renders
// September as "Sept", which is four letters and sits oddly against the other
// months in a column of invoices.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(value) {
  if (!value) return "-";
  const raw = String(value).trim();
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  const d = compact
    ? new Date(Date.UTC(+compact[1], +compact[2] - 1, +compact[3]))
    : new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * @param {object} invoice
 *   voucherNumber, voucherDate, partyLedgerName, partyAddress[], partyGstin,
 *   partyState, items[{name, quantity, rate, amount}], taxes[{name, amount}],
 *   amount (the party total, from Tally)
 * @returns {Promise<Buffer>}
 */
function renderInvoicePdf(invoice) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = PAGE_MARGIN;
    const right = doc.page.width - PAGE_MARGIN;
    const width = right - left;

    // --- letterhead ---------------------------------------------------------
    let y = PAGE_MARGIN;
    if (fs.existsSync(company.letterheadPath)) {
      // Measure the artwork rather than assume a ratio: the letterhead gets
      // recropped whenever better source turns up, and a stale hardcoded height
      // would either stretch it or leave a gap.
      const art = doc.openImage(company.letterheadPath);
      const drawnHeight = (width * art.height) / art.width;
      doc.image(company.letterheadPath, left, y, { width });
      y += drawnHeight + 10;
    } else {
      // Never fail to produce an invoice just because the artwork is missing.
      doc.font("Helvetica-Bold").fontSize(20).fillColor(brand.navy)
        .text(company.legalName, left, y, { width, align: "center" });
      y = doc.y + 10;
    }

    // --- title band ---------------------------------------------------------
    doc.rect(left, y, width, 22).fill(brand.navy);
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#FFFFFF")
      .text("TAX INVOICE", left, y + 6, { width, align: "center" });
    y += 32;

    // --- invoice meta + billed-to ------------------------------------------
    const colW = width / 2 - 8;
    const metaTop = y;

    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(brand.muted).text("BILLED TO", left, y);
    doc.font("Helvetica-Bold").fontSize(11).fillColor(brand.ink)
      .text(invoice.partyLedgerName || "-", left, doc.y + 2, { width: colW });
    doc.font("Helvetica").fontSize(9).fillColor(brand.ink);
    for (const line of (invoice.partyAddress || []).filter(Boolean)) {
      doc.text(line, left, doc.y + 1, { width: colW });
    }
    if (invoice.partyState) doc.text(`State: ${invoice.partyState}`, left, doc.y + 1, { width: colW });
    if (invoice.partyGstin) {
      doc.font("Helvetica-Bold").text(`GSTIN: ${invoice.partyGstin}`, left, doc.y + 1, { width: colW });
    }
    const leftBottom = doc.y;

    // Label and value are two fixed columns, not one `continued` run. Continuing
    // after a 90pt label made the value inherit that width, so "2026-27/No416"
    // wrapped after the slash and every row sat at a different height.
    const rx = left + colW + 16;
    const metaLabelW = 54;
    const metaValueX = rx + metaLabelW;
    const metaValueW = colW - metaLabelW;

    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(brand.muted).text("INVOICE", rx, metaTop);
    let my = metaTop + 14;
    const metaRow = (label, value, bold) => {
      doc.font("Helvetica").fontSize(9).fillColor(brand.muted)
        .text(label, rx, my, { width: metaLabelW, lineBreak: false });
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(brand.ink)
        .text(String(value), metaValueX, my, { width: metaValueW, lineBreak: false });
      my += 13;
    };
    metaRow("Number", invoice.voucherNumber || "-", true);
    metaRow("Date", formatDate(invoice.voucherDate));
    metaRow("GSTIN", company.gstin);
    metaRow("State", `${company.stateName} (${company.stateCode})`);

    y = Math.max(leftBottom, my) + 14;

    // --- items table --------------------------------------------------------
    // HSN is required on a GST tax invoice. Tally carries it per inventory line
    // as GSTHSNNAME, so it is shown per line rather than assumed uniform — a
    // mixed-HSN invoice must not silently print one code against everything.
    const cols = [
      { key: "sn", label: "#", w: 20, align: "left" },
      { key: "name", label: "ITEM", w: width - 20 - 52 - 66 - 74 - 86, align: "left" },
      { key: "hsn", label: "HSN", w: 52, align: "left" },
      { key: "qty", label: "QTY", w: 66, align: "right" },
      { key: "rate", label: "RATE", w: 74, align: "right" },
      { key: "amount", label: "AMOUNT", w: 86, align: "right" },
    ];

    const header = () => {
      doc.rect(left, y, width, 18).fill(brand.band);
      let x = left + 4;
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor(brand.navy);
      for (const c of cols) {
        doc.text(c.label, x, y + 5, { width: c.w - 8, align: c.align });
        x += c.w;
      }
      y += 18;
    };
    header();

    doc.font("Helvetica").fontSize(9).fillColor(brand.ink);
    const items = invoice.items || [];
    items.forEach((item, i) => {
      // Keep the totals block with the table rather than orphaned on page 2.
      if (y > doc.page.height - 190) {
        doc.addPage();
        y = PAGE_MARGIN;
        header();
      }
      const cells = [
        String(i + 1),
        item.name || "-",
        item.hsn || "",
        item.quantity || "",
        item.rate || "",
        money(item.amount),
      ];
      let x = left + 4;
      const h = 15;
      if (i % 2 === 1) doc.rect(left, y, width, h).fill("#FAFBFC").fillColor(brand.ink);
      doc.font("Helvetica").fontSize(9).fillColor(brand.ink);
      cols.forEach((c, ci) => {
        doc.text(cells[ci], x, y + 4, { width: c.w - 8, align: c.align, lineBreak: false });
        x += c.w;
      });
      y += h;
    });

    doc.moveTo(left, y).lineTo(right, y).strokeColor(brand.rule).lineWidth(0.5).stroke();
    y += 8;

    // --- totals -------------------------------------------------------------
    const subtotal = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
    const taxes = invoice.taxes || [];
    const labelX = right - 260;
    const totalLine = (label, value, opts = {}) => {
      doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opts.bold ? 11 : 9.5)
        .fillColor(opts.bold ? brand.navy : brand.ink);
      doc.text(label, labelX, y, { width: 160, align: "right" });
      doc.text(money(value), labelX + 166, y, { width: 94, align: "right" });
      y += opts.bold ? 18 : 14;
    };

    totalLine("Subtotal", subtotal);
    for (const tax of taxes) totalLine(tax.name, tax.amount);

    doc.moveTo(labelX, y).lineTo(right, y).strokeColor(brand.navy).lineWidth(1).stroke();
    y += 6;
    const grandTotal = Number(invoice.amount) || subtotal + taxes.reduce((s, t) => s + (Number(t.amount) || 0), 0);
    totalLine("TOTAL", grandTotal, { bold: true });

    // Tally is the system of record. If our lines don't reconcile to its total,
    // say so on the document rather than presenting a figure we invented.
    const computed = subtotal + taxes.reduce((s, t) => s + (Number(t.amount) || 0), 0);
    if (Math.abs(computed - grandTotal) > 0.5) {
      doc.font("Helvetica-Oblique").fontSize(8).fillColor(brand.red)
        .text(`Note: line items total ${money(computed)}; invoice total per books is ${money(grandTotal)}.`,
          left, y, { width });
      y = doc.y;
    }

    y += 4;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(brand.ink)
      .text("Amount in words: ", left, y, { continued: true })
      .font("Helvetica").text(amountInWords(grandTotal), { width: width - 90 });
    y = doc.y + 12;

    // --- bank + terms -------------------------------------------------------
    const boxTop = y;
    doc.rect(left, boxTop, width, 56).fillAndStroke(brand.band, brand.rule);
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(brand.navy).text("BANK DETAILS", left + 8, boxTop + 6);
    doc.font("Helvetica").fontSize(8.5).fillColor(brand.ink)
      .text(`${company.bank.accountName}  ·  A/C ${company.bank.accountNumber}`, left + 8, boxTop + 19)
      .text(`${company.bank.name}, ${company.bank.branch}  ·  IFSC ${company.bank.ifsc}`, left + 8, boxTop + 31)
      .text(`GSTIN ${company.gstin}  ·  PAN ${company.pan}  ·  ${company.email}`, left + 8, boxTop + 43);

    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(brand.ink)
      .text("For " + company.legalName, right - 180, boxTop + 12, { width: 172, align: "right" });
    doc.font("Helvetica").fontSize(8).fillColor(brand.muted)
      .text("Authorised Signatory", right - 180, boxTop + 42, { width: 172, align: "right" });

    y = boxTop + 64;
    doc.font("Helvetica").fontSize(7.5).fillColor(brand.muted)
      .text(company.terms, left, y, { width });
    doc.text("This is a computer-generated copy of the tax invoice.", left, doc.y + 2, { width });

    doc.end();
  });
}

module.exports = { renderInvoicePdf, amountInWords };
