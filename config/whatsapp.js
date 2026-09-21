// WhatsApp sending via Slide (https://slide.synquic.com).
//
// Follows the config/cloudinary.js pattern: env read inline, presence-only
// credential logging, ready-made client exported.
//
// Two hard rules:
//   1. sendTemplateMessage NEVER throws. Every path returns a result object, so
//      a provider outage can never turn into a failed order.
//   2. With no SLIDE_API_KEY it no-ops cleanly. That's the normal state until the
//      Meta templates are approved, so it must be boring and silent-ish, not an error.

const FALLBACK_BASE_URL = 'https://slide.synquic.com/api/v1';
const DEFAULT_TIMEOUT_MS = 10000;

const whatsappConfig = {
  get baseUrl() {
    // The configured value already ends in /api/v1 — strip trailing slashes so we
    // never build a double-prefixed URL (which 404s and looks like a routing bug).
    return String(process.env.SLIDE_API_BASE_URL || FALLBACK_BASE_URL).replace(/\/+$/, '');
  },
  get templateName() {
    return process.env.SLIDE_WHATSAPP_TEMPLATE || 'order_confirmation';
  },
  get templateNameWithValue() {
    return process.env.SLIDE_WHATSAPP_TEMPLATE_WITH_VALUE || 'order_confirmation_with_value';
  },
  // Public URL of the image shown in the header of templates that have an IMAGE
  // header (order_confirmation_with_value). WhatsApp fetches it itself, so it must
  // be publicly reachable — a local file path or a private URL fails the send.
  get headerImageUrl() {
    return process.env.SLIDE_WHATSAPP_HEADER_IMAGE_URL || 'https://www.sajanshreegarments.in/logo.png';
  },
  get languageCode() {
    // Must byte-match the locale the template was approved under at Meta —
    // "en" and "en_US" are different templates and a mismatch 404s every send.
    return process.env.SLIDE_WHATSAPP_LANGUAGE || 'en';
  },
  get timeoutMs() {
    return Number(process.env.SLIDE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  },
};

function isWhatsAppConfigured() {
  return Boolean(process.env.SLIDE_API_KEY) && process.env.WHATSAPP_ENABLED !== 'false';
}

// Test mode: divert EVERY outbound message to one number.
//
// Deliberately central rather than per-feature. While this is set, nothing can
// reach a real customer by any path — orders, Tally invoices, cron retries — so
// testing a new integration on live data can't embarrass anyone. A per-feature
// switch would leave the other paths live, which is the failure we're avoiding.
//
// The tradeoff is that it's silent to the caller, so it logs on every single send.
function testRedirectNumber() {
  return String(process.env.WHATSAPP_TEST_REDIRECT_TO || '').replace(/\D/g, '');
}

console.log('🔧 Configuring WhatsApp (Slide)...');
console.log('🔑 Slide API Key:', process.env.SLIDE_API_KEY ? '✓ Set' : '✗ Missing');
console.log('🌐 Slide Base URL:', whatsappConfig.baseUrl);
console.log('🧾 Template:', `${whatsappConfig.templateName} (${whatsappConfig.languageCode})`);
if (!isWhatsAppConfigured()) {
  console.log('💤 WhatsApp sending is DISABLED — orders will still save normally.');
}
if (testRedirectNumber()) {
  console.warn('🧪 ============================================================');
  console.warn(`🧪 WHATSAPP TEST MODE ACTIVE — every message goes to ${testRedirectNumber()}`);
  console.warn('🧪 No real customer can receive a message while this is set.');
  console.warn('🧪 Clear WHATSAPP_TEST_REDIRECT_TO before going live.');
  console.warn('🧪 ============================================================');
}
// Note: no boot-time connectivity ping (unlike Cloudinary). Slide's nearest
// equivalent needs the whatsapp:templates:read scope, which a send-only key
// won't have, so it would log an alarming 403 on every restart.

let warnedNotConfigured = false;

/**
 * Send one pre-approved WhatsApp template message. Never throws.
 *
 * @returns {Promise<{ok: boolean, status: string, [key: string]: any}>}
 */
async function sendTemplateMessage({ to, templateName, languageCode, bodyParameters, headerImageUrl }) {
  if (!isWhatsAppConfigured()) {
    if (!warnedNotConfigured) {
      console.log('💤 Skipping WhatsApp send: SLIDE_API_KEY not set (logged once per process).');
      warnedNotConfigured = true;
    }
    return { ok: false, status: 'disabled', retryable: false, message: 'WhatsApp is not configured' };
  }

  const url = `${whatsappConfig.baseUrl}/whatsapp/send-template`;

  let recipient = to;
  const redirect = testRedirectNumber();
  if (redirect && redirect !== to) {
    console.warn(
      `🧪 WHATSAPP TEST MODE: diverting message intended for ${to} → ${redirect}. ` +
        `Unset WHATSAPP_TEST_REDIRECT_TO to send to real customers.`
    );
    recipient = redirect;
  }

  const payload = {
    to: recipient,
    templateName: templateName || whatsappConfig.templateName,
    languageCode: languageCode || whatsappConfig.languageCode,
    // A template with an IMAGE header is rejected by Meta (132012) unless the
    // send supplies one, so the header component is added only when asked for.
    components: [
      ...(headerImageUrl
        ? [{ type: 'header', parameters: [{ type: 'image', image: { link: headerImageUrl } }] }]
        : []),
      { type: 'body', parameters: bodyParameters },
    ],
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SLIDE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(whatsappConfig.timeoutMs),
    });
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    return {
      ok: false,
      status: 'failed',
      httpStatus: null,
      retryable: true,
      message: timedOut
        ? `Slide request timed out after ${whatsappConfig.timeoutMs}ms`
        : error.message,
    };
  }

  // Read as text first: an edge/proxy 502 returns HTML, and res.json() would throw,
  // which would break the never-throws contract.
  const rawBody = await response.text().catch(() => '');
  let body = null;
  try {
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    body = null;
  }

  if (response.ok) {
    return {
      ok: true,
      status: 'sent',
      wamid: body?.wamid,
      conversationId: body?.conversationId,
      providerStatus: body?.status,
      templateName: payload.templateName,
      languageCode: payload.languageCode,
      // The number actually messaged. While test mode is on this is NOT the
      // recipient the caller asked for, and a record storing the intended
      // number would claim a customer was messaged when they were not.
      deliveredTo: recipient,
      redirected: recipient !== to,
    };
  }

  // 429 and 5xx are worth retrying. A 400/401/403/404/422 means bad key, missing
  // scope, or an unapproved template — retrying those just burns quota.
  const retryable = response.status === 429 || response.status >= 500;
  return {
    ok: false,
    status: 'failed',
    httpStatus: response.status,
    retryable,
    errorCode: body?.error,
    message: body?.message || rawBody.slice(0, 300) || `Slide returned ${response.status}`,
    retryAfterSeconds: Number(response.headers.get('retry-after')) || null,
  };
}

module.exports = { isWhatsAppConfigured, sendTemplateMessage, whatsappConfig };
