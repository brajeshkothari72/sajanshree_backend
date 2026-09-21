const test = require('node:test');
const assert = require('node:assert');

// Keep module-level config predictable regardless of the developer's .env.
delete process.env.SLIDE_API_KEY;
delete process.env.WHATSAPP_TEST_REDIRECT_TO;
process.env.WHATSAPP_ENABLED = 'true';
process.env.SLIDE_WHATSAPP_INVOICE_TEMPLATE = 'invoice_notification';
process.env.SLIDE_WHATSAPP_LANGUAGE = 'en';

const { parseTallyDate } = require('../controllers/tallyController');
const { buildInvoiceParams, invoiceTemplateName } = require('../utils/invoiceNotifications');
const { normalizePayload } = require('../tally-companion/companion');

// --- Tally date parsing ------------------------------------------------------

test('parses Tally compact YYYYMMDD dates', () => {
  const d = parseTallyDate('20260812');
  assert.strictEqual(d.getUTCFullYear(), 2026);
  assert.strictEqual(d.getUTCMonth(), 7); // August is 7
  assert.strictEqual(d.getUTCDate(), 12);
});

test('parses compact dates in UTC so the invoice never shifts a day', () => {
  // Built with Date.UTC rather than new Date(y, m, d): a local-time construction
  // would render as the 11th for anyone running the server west of the shop.
  const d = parseTallyDate('20260812');
  assert.strictEqual(d.toISOString().slice(0, 10), '2026-08-12');
});

test('still accepts an ISO date, since the companion may forward either form', () => {
  const d = parseTallyDate('2026-08-12T00:00:00Z');
  assert.strictEqual(d.toISOString().slice(0, 10), '2026-08-12');
});

test('returns null for empty or unparseable dates rather than Invalid Date', () => {
  assert.strictEqual(parseTallyDate(''), null);
  assert.strictEqual(parseTallyDate(null), null);
  assert.strictEqual(parseTallyDate(undefined), null);
  assert.strictEqual(parseTallyDate('not a date'), null);
});

// --- invoice message building ------------------------------------------------

const baseInvoice = (overrides = {}) => ({
  voucherNumber: 'SS/2026-27/309',
  voucherDate: new Date('2026-08-12T00:00:00Z'),
  partyLedgerName: 'Vimal Sulz Ltd',
  amount: 15750.5,
  ...overrides,
});

test('builds the 4 documented params in body order', () => {
  const params = buildInvoiceParams(baseInvoice());
  assert.strictEqual(params.length, 4);
  assert.deepStrictEqual(params.map((p) => p.type), ['text', 'text', 'text', 'text']);
  assert.strictEqual(params[0].text, 'Vimal Sulz Ltd');   // {{1}} full party name
  assert.strictEqual(params[1].text, 'SS/2026-27/309');   // {{2}} invoice number
  assert.strictEqual(params[2].text, '15,750.50');        // {{3}} amount, Indian grouping
  assert.strictEqual(params[3].text, '12 Aug 2026');      // {{4}} date
});

test('never emits an empty parameter, which Meta rejects outright', () => {
  const params = buildInvoiceParams({
    voucherNumber: '',
    partyLedgerName: '',
    amount: undefined,
    voucherDate: undefined,
  });
  for (const p of params) {
    assert.ok(p.text.length > 0, `parameter was empty: ${JSON.stringify(p)}`);
  }
});

test('uses a single invoice template — the amount is never hidden on a bill', () => {
  // Unlike orders, which switch templates on a "include value" checkbox. A bill
  // the customer just paid has no variant where hiding the value makes sense.
  assert.strictEqual(invoiceTemplateName(), 'invoice_notification');
});

// --- companion payload normalization ----------------------------------------

test('flattens the nested envelope TallyPrime actually sends', () => {
  // This is the real shape observed from TallyPrime 7.1 on 13-Sep-2026:
  // HTTP Request wraps the request report in ENVELOPE -> <XML Tag>.
  const out = normalizePayload({
    ENVELOPE: {
      invoice: {
        voucherGuid: 'abc-123',
        voucherNumber: 'SS/2026-27/309',
        partyLedgerName: 'Vimal Sulz Ltd',
        partyPhone: '9876543210',
        amount: '15750.50',
      },
    },
  });

  assert.strictEqual(out.voucherGuid, 'abc-123');
  assert.strictEqual(out.voucherNumber, 'SS/2026-27/309');
  assert.strictEqual(out.partyLedgerName, 'Vimal Sulz Ltd');
  assert.strictEqual(out.partyPhone, '9876543210');
});

test('recognises Tally tag spellings, not just our own field names', () => {
  const out = normalizePayload({
    ENVELOPE: {
      invoice: {
        VCHGUID: 'g-1',
        VOUCHERNUMBER: 'SS/1',
        PARTYLEDGERNAME: 'Some Party',
        LEDGERMOBILE: '9876543210',
        SVCURRENTCOMPANY: 'Sajan Shree Garments',
      },
    },
  });

  assert.strictEqual(out.voucherGuid, 'g-1');
  assert.strictEqual(out.voucherNumber, 'SS/1');
  assert.strictEqual(out.partyLedgerName, 'Some Party');
  assert.strictEqual(out.partyPhone, '9876543210');
  assert.strictEqual(out.companyName, 'Sajan Shree Garments');
});

test('treats empty strings as absent so blank Tally tags do not mask a later value', () => {
  const out = normalizePayload({ invoice: { partyPhone: '', LEDGERMOBILE: '9876543210' } });
  assert.strictEqual(out.partyPhone, '9876543210');
});

test('reports an empty payload as empty rather than inventing fields', () => {
  // The exact failure seen on the first live test: structure arrived, values did not.
  const out = normalizePayload({ ENVELOPE: { invoice: {} } });
  assert.strictEqual(out.voucherGuid, undefined);
  assert.strictEqual(out.voucherNumber, undefined);
  assert.strictEqual(out.partyLedgerName, undefined);
});

// --- test-mode redirect ------------------------------------------------------

test('test redirect diverts every send away from the real recipient', async () => {
  process.env.SLIDE_API_KEY = 'test-key';
  process.env.WHATSAPP_TEST_REDIRECT_TO = '919999888877';
  delete require.cache[require.resolve('../config/whatsapp')];
  const { sendTemplateMessage } = require('../config/whatsapp');

  const originalFetch = global.fetch;
  let sentTo = null;
  global.fetch = async (_url, options) => {
    sentTo = JSON.parse(options.body).to;
    return { ok: true, status: 200, text: async () => JSON.stringify({ wamid: 'w1' }), headers: new Map() };
  };

  try {
    await sendTemplateMessage({
      to: '919876543210',                       // a real customer
      templateName: 'invoice_notification',
      languageCode: 'en',
      bodyParameters: [{ type: 'text', text: 'x' }],
    });
    assert.strictEqual(sentTo, '919999888877', 'message must be diverted to the test number');
  } finally {
    global.fetch = originalFetch;
    delete process.env.WHATSAPP_TEST_REDIRECT_TO;
    delete process.env.SLIDE_API_KEY;
    delete require.cache[require.resolve('../config/whatsapp')];
  }
});

// --- repeat-voucher handling -------------------------------------------------
//
// TallyPrime fires the save hook two or three times per voucher (observed
// directly), so this decides whether a customer gets one message or three.

const { describeChange } = require('../controllers/tallyController');

test('an identical repeat is not material — Tally double-fire must not resend', () => {
  const r = describeChange({ amount: 5355, partyPhone: '9876543210' },
                           { amount: 5355, partyPhone: '9876543210' });
  assert.strictEqual(r.material, false);
});

test('a changed amount is material — the bill the customer holds is wrong', () => {
  const r = describeChange({ amount: 100, partyPhone: '9876543210' },
                           { amount: 250, partyPhone: '9876543210' });
  assert.strictEqual(r.amountChanged, true);
  assert.strictEqual(r.material, true);
});

test('a corrected phone number is material — the first message went nowhere useful', () => {
  const r = describeChange({ amount: 100, partyPhone: '905790886' },
                           { amount: 100, partyPhone: '9057908866' });
  assert.strictEqual(r.phoneChanged, true);
  assert.strictEqual(r.material, true);
});

test('float noise does not count as a change', () => {
  // Amounts arrive as strings from Tally and round-trip through Number; an
  // exact !== would resend on representation noise alone.
  const r = describeChange({ amount: 5355.0 }, { amount: '5355.00' });
  assert.strictEqual(r.material, false);
});

test('a renumbered voucher alone is not material', () => {
  // Auto Renumber shifts numbers when vouchers are inserted or deleted. The
  // number is not part of this decision at all, by design.
  const r = describeChange({ amount: 4893, partyPhone: '9644400090' },
                           { amount: 4893, partyPhone: '9644400090' });
  assert.strictEqual(r.material, false);
});
