const test = require('node:test');
const assert = require('node:assert');

// Keep the module-level config predictable regardless of the developer's .env.
delete process.env.SLIDE_API_KEY;
process.env.WHATSAPP_ENABLED = 'true';
process.env.SLIDE_WHATSAPP_TEMPLATE = 'order_confirmation';
process.env.SLIDE_WHATSAPP_TEMPLATE_WITH_VALUE = 'order_confirmation_with_value';
process.env.SLIDE_WHATSAPP_LANGUAGE = 'en';

const { sendTemplateMessage, isWhatsAppConfigured } = require('../config/whatsapp');
const {
  buildInitialNotificationState,
  buildOrderConfirmationParams,
  summarizeOrder,
  sanitizeParam,
} = require('../utils/orderNotifications');

const baseOrder = (overrides = {}) => ({
  _id: 'abc123',
  orderId: 'ORD-1001',
  customerName: 'Ramesh Kumar',
  deliveryDate: new Date('2026-06-20T00:00:00Z'),
  items: [
    { product: 'Shirt', sizes: { 24: { quantity: 40, price: 320 }, 26: { quantity: 55, price: 330 } } },
    { product: 'Skirt', sizes: { 18: { quantity: 25, price: 280 } } },
  ],
  ...overrides,
});

// --- message building -------------------------------------------------------

test('summarizes an order identically whether sizes is a Map or a plain object', () => {
  const plain = summarizeOrder(baseOrder());

  const mapOrder = baseOrder({
    items: [
      { product: 'Shirt', sizes: new Map([['24', { quantity: 40, price: 320 }], ['26', { quantity: 55, price: 330 }]]) },
      { product: 'Skirt', sizes: new Map([['18', { quantity: 25, price: 280 }]]) },
    ],
  });
  const mapped = summarizeOrder(mapOrder);

  assert.deepStrictEqual(plain, mapped);
  assert.strictEqual(plain.pieces, 120);              // 40 + 55 + 25
  assert.strictEqual(plain.amount, 37950);            // 12800 + 18150 + 7000
  assert.deepStrictEqual(plain.products, ['Shirt', 'Skirt']);
});

test('builds 4 params and the base template when the value is not included', () => {
  const { templateName, parameters } = buildOrderConfirmationParams(baseOrder());
  assert.strictEqual(templateName, 'order_confirmation');
  assert.strictEqual(parameters.length, 4);
  assert.deepStrictEqual(parameters.map((p) => p.text), [
    'Ramesh',
    'ORD-1001',
    '120 pcs (Shirt, Skirt)',
    '20 Jun 2026',
  ]);
  assert.ok(parameters.every((p) => p.type === 'text'));
});

test('builds 5 params and the with-value template when the toggle is on', () => {
  const { templateName, parameters } = buildOrderConfirmationParams(
    baseOrder({ includeValueInWhatsApp: true })
  );
  assert.strictEqual(templateName, 'order_confirmation_with_value');
  assert.strictEqual(parameters.length, 5);
  assert.strictEqual(parameters[3].text, '37,950.00');   // en-IN, no "Rs." (that's in the template body)
  assert.strictEqual(parameters[4].text, '20 Jun 2026');
});

test('sanitizes parameters so Meta will not reject the send', () => {
  assert.strictEqual(sanitizeParam('Blue\nShirt\twith      gaps'), 'Blue Shirt with gaps');
  assert.strictEqual(sanitizeParam(''), '-');
  assert.strictEqual(sanitizeParam(null), '-');
  assert.strictEqual(sanitizeParam('x'.repeat(200)).length, 120);
});

test('never emits an empty parameter even for a threadbare order', () => {
  const { parameters } = buildOrderConfirmationParams({ _id: 'x', items: [] });
  assert.ok(parameters.every((p) => p.text.length > 0));
});

// --- initial state ----------------------------------------------------------

test('initial state is "disabled" when no API key is configured', () => {
  assert.deepStrictEqual(buildInitialNotificationState('9876543210', true), { status: 'disabled' });
});

test('initial state reflects phone and consent once configured', () => {
  process.env.SLIDE_API_KEY = 'sk_test_fake';
  try {
    assert.deepStrictEqual(buildInitialNotificationState('', true), { status: 'skipped_no_phone' });
    assert.deepStrictEqual(buildInitialNotificationState('022-2345 6789', true), {
      status: 'skipped_invalid_phone',
      lastError: 'NOT_A_MOBILE',
    });
    assert.deepStrictEqual(buildInitialNotificationState('9876543210', false), {
      status: 'skipped_no_consent',
      to: '919876543210',
    });
    assert.deepStrictEqual(buildInitialNotificationState('9876543210', true), {
      status: 'queued',
      to: '919876543210',
      attempts: 0,
    });
  } finally {
    delete process.env.SLIDE_API_KEY;
  }
});

// --- provider: the unconfigured no-op (the day-one path) --------------------

test('sendTemplateMessage no-ops without touching the network when unconfigured', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network must not be touched when unconfigured'); };
  try {
    assert.strictEqual(isWhatsAppConfigured(), false);
    const result = await sendTemplateMessage({ to: '919876543210', bodyParameters: [] });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'disabled');
    assert.strictEqual(result.retryable, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('WHATSAPP_ENABLED=false acts as a kill switch even with a key present', async () => {
  process.env.SLIDE_API_KEY = 'sk_test_fake';
  process.env.WHATSAPP_ENABLED = 'false';
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network must not be touched when disabled'); };
  try {
    const result = await sendTemplateMessage({ to: '919876543210', bodyParameters: [] });
    assert.strictEqual(result.status, 'disabled');
  } finally {
    globalThis.fetch = realFetch;
    process.env.WHATSAPP_ENABLED = 'true';
    delete process.env.SLIDE_API_KEY;
  }
});

// --- provider: faked responses, no real API --------------------------------

async function withFakeFetch(impl, run) {
  process.env.SLIDE_API_KEY = 'sk_test_fake';
  const realFetch = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.SLIDE_API_KEY;
  }
}

const fakeResponse = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

test('parses a successful send', async () => {
  await withFakeFetch(
    async () => fakeResponse(200, { wamid: 'wamid.TEST', conversationId: 'conv_1', status: 'sent' }),
    async () => {
      const result = await sendTemplateMessage({ to: '919876543210', bodyParameters: [] });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.status, 'sent');
      assert.strictEqual(result.wamid, 'wamid.TEST');
      assert.strictEqual(result.conversationId, 'conv_1');
    }
  );
});

test('sends the documented payload shape to the right URL', async () => {
  let captured = null;
  await withFakeFetch(
    async (url, init) => { captured = { url, init }; return fakeResponse(200, { wamid: 'w', status: 'sent' }); },
    async () => {
      await sendTemplateMessage({
        to: '919876543210',
        templateName: 'order_confirmation',
        languageCode: 'en',
        bodyParameters: [{ type: 'text', text: 'Ramesh' }],
      });
    }
  );

  assert.strictEqual(captured.url, 'https://slide.synquic.com/api/v1/whatsapp/send-template');
  assert.strictEqual(captured.init.headers.Authorization, 'Bearer sk_test_fake');
  assert.deepStrictEqual(JSON.parse(captured.init.body), {
    to: '919876543210',
    templateName: 'order_confirmation',
    languageCode: 'en',
    components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ramesh' }] }],
  });
});

test('treats auth/scope/validation errors as non-retryable', async () => {
  for (const status of [400, 401, 403, 422]) {
    await withFakeFetch(
      async () => fakeResponse(status, { statusCode: status, error: 'Nope', message: 'bad thing' }),
      async () => {
        const result = await sendTemplateMessage({ to: '9', bodyParameters: [] });
        assert.strictEqual(result.ok, false, `status ${status}`);
        assert.strictEqual(result.retryable, false, `status ${status} should not retry`);
        assert.strictEqual(result.message, 'bad thing');
        assert.strictEqual(result.httpStatus, status);
      }
    );
  }
});

test('treats rate limiting and server errors as retryable', async () => {
  await withFakeFetch(
    async () => fakeResponse(429, { message: 'Rate limit exceeded' }, { 'retry-after': '23' }),
    async () => {
      const result = await sendTemplateMessage({ to: '9', bodyParameters: [] });
      assert.strictEqual(result.retryable, true);
      assert.strictEqual(result.retryAfterSeconds, 23);
    }
  );

  await withFakeFetch(
    async () => fakeResponse(500, { message: 'boom' }),
    async () => assert.strictEqual((await sendTemplateMessage({ to: '9', bodyParameters: [] })).retryable, true)
  );
});

test('survives a non-JSON error body (proxy returning HTML)', async () => {
  await withFakeFetch(
    async () => fakeResponse(502, '<html><body>Bad Gateway</body></html>'),
    async () => {
      const result = await sendTemplateMessage({ to: '9', bodyParameters: [] });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.retryable, true);
      assert.match(result.message, /Bad Gateway/);
    }
  );
});

test('treats a network failure as a retryable failure rather than throwing', async () => {
  await withFakeFetch(
    async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; },
    async () => {
      const result = await sendTemplateMessage({ to: '9', bodyParameters: [] });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.retryable, true);
      assert.match(result.message, /timed out/);
    }
  );
});

// --- image header (Meta 132012 regression) ----------------------------------

test('with-value orders carry the header image; plain orders do not', () => {
  const withValue = buildOrderConfirmationParams(baseOrder({ includeValueInWhatsApp: true }));
  assert.strictEqual(withValue.headerImageUrl, 'https://www.sajanshreegarments.in/logo.png');

  const plain = buildOrderConfirmationParams(baseOrder());
  assert.strictEqual(plain.headerImageUrl, undefined);
});

test('sends a header component before the body when a header image is supplied', async () => {
  let captured = null;
  await withFakeFetch(
    async (url, init) => { captured = JSON.parse(init.body); return fakeResponse(200, { wamid: 'w', status: 'sent' }); },
    async () => {
      await sendTemplateMessage({
        to: '919876543210',
        templateName: 'order_confirmation_with_value',
        bodyParameters: [{ type: 'text', text: 'Ramesh' }],
        headerImageUrl: 'https://www.sajanshreegarments.in/logo.png',
      });
    }
  );
  assert.deepStrictEqual(captured.components, [
    { type: 'header', parameters: [{ type: 'image', image: { link: 'https://www.sajanshreegarments.in/logo.png' } }] },
    { type: 'body', parameters: [{ type: 'text', text: 'Ramesh' }] },
  ]);
});

test('sends no header component when none is supplied', async () => {
  let captured = null;
  await withFakeFetch(
    async (url, init) => { captured = JSON.parse(init.body); return fakeResponse(200, { wamid: 'w', status: 'sent' }); },
    async () => { await sendTemplateMessage({ to: '919876543210', bodyParameters: [] }); }
  );
  assert.deepStrictEqual(captured.components.map((c) => c.type), ['body']);
});
