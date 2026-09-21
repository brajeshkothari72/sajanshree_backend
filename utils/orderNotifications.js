// Maps an Order to its WhatsApp confirmation message and records the outcome.
// Shared by createOrder (auto-send), the manual resend endpoint, and the cron retry sweep.

const Order = require("../models/orderModel");
const { normalizeToWhatsAppNumber } = require("./phone");
const { isWhatsAppConfigured, sendTemplateMessage, whatsappConfig } = require("../config/whatsapp");

const MAX_ATTEMPTS = 3;

// Meta rejects a send whose parameter contains a newline, a tab, more than four
// consecutive spaces, or is empty — so every parameter goes through this.
function sanitizeParam(value) {
  return (
    String(value ?? "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 120) || "-"
  );
}

// `sizes` is a Mongoose Map on a hydrated doc but a plain object on a .lean() result.
function sizeEntries(sizes) {
  if (!sizes) return [];
  return sizes instanceof Map ? [...sizes.entries()] : Object.entries(sizes);
}

// Mirrors OrderDetail.calculateOrderTotal so the message never disagrees with the UI.
function summarizeOrder(order) {
  let pieces = 0;
  let amount = 0;
  const products = [];

  for (const item of order.items || []) {
    if (item.product) products.push(item.product);
    for (const [, cell] of sizeEntries(item.sizes)) {
      const quantity = Number(cell?.quantity) || 0;
      const price = Number(cell?.price) || 0;
      pieces += quantity;
      amount += quantity * price;
    }
  }

  return { pieces, amount, products: [...new Set(products)] };
}

function formatItemsSummary({ pieces, products }) {
  let names = products.join(", ");
  if (names.length > 60) names = `${names.slice(0, 57)}...`;
  return names ? `${pieces} pcs (${names})` : `${pieces} pcs`;
}

/**
 * Build the template name and positional parameters for an order.
 * The "Rs." prefix lives in the approved template body, not in the parameter.
 */
function buildOrderConfirmationParams(order) {
  const summary = summarizeOrder(order);
  const firstName = String(order.customerName || "").trim().split(/\s+/)[0] || "there";
  const deliveryDate = order.deliveryDate
    ? new Date(order.deliveryDate).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "-";

  const values = [firstName, order.orderId || String(order._id), formatItemsSummary(summary)];

  // A template body is fixed and Meta rejects empty parameters, so the value
  // toggle selects a different approved template rather than dropping a line.
  if (order.includeValueInWhatsApp) {
    values.push(
      summary.amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    );
  }
  values.push(deliveryDate);

  return {
    templateName: order.includeValueInWhatsApp
      ? whatsappConfig.templateNameWithValue
      : whatsappConfig.templateName,
    // Only the with-value template has an IMAGE header. Sending a header to a
    // template that lacks one is rejected just like omitting a required one.
    headerImageUrl: order.includeValueInWhatsApp ? whatsappConfig.headerImageUrl : undefined,
    parameters: values.map((text) => ({ type: "text", text: sanitizeParam(text) })),
  };
}

/**
 * Decide the notification state to store when an order is first created, without
 * touching the network. Lets createOrder seed the state on its existing save().
 */
function buildInitialNotificationState(rawPhone, consent) {
  if (!isWhatsAppConfigured()) return { status: "disabled" };
  if (!rawPhone) return { status: "skipped_no_phone" };

  const normalized = normalizeToWhatsAppNumber(rawPhone);
  if (!normalized.ok) return { status: "skipped_invalid_phone", lastError: normalized.reason };
  if (!consent) return { status: "skipped_no_consent", to: normalized.value };

  return { status: "queued", to: normalized.value, attempts: 0 };
}

/**
 * Send (or resend) the confirmation for one order and persist the outcome.
 * Never throws — callers treat the returned object as the result.
 */
async function sendOrderConfirmation(orderId, options = {}) {
  const { overridePhone = null, requireConsent = true } = options;

  try {
    const order = await Order.findById(orderId);
    if (!order) return { ok: false, status: "failed", message: "Order not found" };

    if (!isWhatsAppConfigured()) {
      return { ok: false, status: "disabled", message: "WhatsApp is not configured" };
    }

    const rawPhone = overridePhone || order.customerPhone;
    if (!rawPhone) {
      await persist(order, { status: "skipped_no_phone" });
      return { ok: false, status: "skipped_no_phone", message: "No phone number on this order" };
    }

    const normalized = normalizeToWhatsAppNumber(rawPhone);
    if (!normalized.ok) {
      await persist(order, { status: "skipped_invalid_phone", lastError: normalized.reason });
      return { ok: false, status: "skipped_invalid_phone", reason: normalized.reason };
    }

    if (requireConsent && !order.whatsappConsent) {
      await persist(order, { status: "skipped_no_consent", to: normalized.value });
      return { ok: false, status: "skipped_no_consent", message: "Customer has not consented" };
    }

    const { templateName, parameters, headerImageUrl } = buildOrderConfirmationParams(order);
    const attempts = (order.whatsappNotification?.attempts || 0) + 1;

    console.log(`📤 Sending WhatsApp confirmation for ${order.orderId} (attempt ${attempts})...`);
    const result = await sendTemplateMessage({
      to: normalized.value,
      templateName,
      languageCode: whatsappConfig.languageCode,
      bodyParameters: parameters,
      headerImageUrl,
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
      console.log(`✅ WhatsApp confirmation sent for ${order.orderId} (wamid: ${result.wamid})`);
      await persist(order, {
        ...base,
        status: "sent",
        wamid: result.wamid,
        conversationId: result.conversationId,
        sentAt: new Date(),
      });
    } else {
      console.error(`⚠️ WhatsApp confirmation failed for ${order.orderId}: ${result.message}`);
      await persist(order, {
        ...base,
        // A non-retryable failure is parked at the attempt cap so the cron sweep
        // stops hammering a bad key or an unapproved template.
        status: "failed",
        attempts: result.retryable ? attempts : MAX_ATTEMPTS,
        lastError: String(result.message || "").slice(0, 300),
        lastErrorCode: result.httpStatus || undefined,
      });
    }

    return result;
  } catch (error) {
    console.error("⚠️ sendOrderConfirmation error:", error.message);
    return { ok: false, status: "failed", message: error.message, retryable: true };
  }
}

// Atomic $set on one path. Deliberately not doc.save(): createOrder has already
// serialized this document into its 201 response, and a second save() could hit a
// VersionError or rewrite unrelated dirty paths.
async function persist(order, notification) {
  await Order.updateOne({ _id: order._id }, { $set: { whatsappNotification: notification } });
}

module.exports = {
  MAX_ATTEMPTS,
  buildInitialNotificationState,
  buildOrderConfirmationParams,
  sendOrderConfirmation,
  summarizeOrder,
  sanitizeParam,
};
