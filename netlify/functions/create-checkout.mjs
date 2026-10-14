// Prism Meals & Co. — card payments
// Creates a Stripe Checkout page for the customer's cart. Customers pay by credit or debit card
// on Stripe's own secure page; card numbers never touch your website or this function.
//
// SETUP (full steps in PAYMENTS-SETUP.md). Set these in Netlify > Site configuration > Environment variables:
//   STRIPE_SECRET_KEY  your Stripe secret key (starts with sk_test_ while testing, sk_live_ when real)
//   SITE_URL           your public website address, e.g. https://prismmealsco.com
//   ALLOWED_ORIGINS    optional, comma-separated extra addresses allowed to call this function
//
// TAX (optional, see PAYMENTS-SETUP.md). Default is no tax added.
//   TAX_MODE           none (default) | stripe | fixed
//     stripe  = Stripe Tax works out the tax automatically at payment (turn on Stripe Tax first)
//     fixed   = you charge one flat rate on every order
//   TAX_BEHAVIOR       stripe mode only: exclusive (default, tax added on top) or inclusive (price already includes tax)
//   TAX_CODE           stripe mode only: optional Stripe product tax code (or set a preset one in Stripe's tax settings)
//   TAX_RATE_PERCENT   fixed mode only: for example 13
//   TAX_LABEL          fixed mode only: wording on the receipt, default HST
//   PICKUP_STREET, PICKUP_CITY, PICKUP_POSTAL   stripe mode: where pickup orders are collected, so tax uses that address

/* ------------------------------------------------------------------
   PRODUCTS. The price here MUST match the price in index.html.
   cents: 999 means $9.99 CAD. Add more products the same way.
   ------------------------------------------------------------------ */
const PRODUCTS = {
  'italian-garden': { name: 'Italian Garden Soup Mix (350 g)', cents: 999 }
};
const CURRENCY = 'cad';
const MAX_PER_ITEM = 24;
// Optional flat fee added when the customer chooses delivery (0 = no fee).
// If you set this above 0, also update the delivery wording in index.html.
const DELIVERY_FEE_CENTS = 0;

const FULFILLMENT = ['pickup', 'delivery'];

const env = (k) => {
  try { if (typeof Netlify !== 'undefined' && Netlify.env) { const v = Netlify.env.get(k); if (v) return String(v).trim(); } } catch (_) {}
  const v = process.env[k];
  return typeof v === 'string' ? v.trim() : v;
};

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function corsHeaders(origin, allowed) {
  const h = { 'Vary': 'Origin' };
  if (origin && allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

async function stripePost(path, params, secret) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data && data.error && data.error.message) || `stripe ${res.status}`);
  return data;
}

export default async (req) => {
  const siteUrl = (env('SITE_URL') || '').replace(/\/+$/, '');
  const allowed = [];
  try { if (siteUrl) allowed.push(new URL(siteUrl).origin); } catch (_) {}
  try { allowed.push(new URL(req.url).origin); } catch (_) {}
  (env('ALLOWED_ORIGINS') || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean).forEach((o) => allowed.push(o));

  const origin = req.headers.get('origin');
  const cors = corsHeaders(origin, allowed);
  const reply = (status, body) => {
    if (status >= 400) console.error('create-checkout failed:', status, body && body.error);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  };

  // Open  <your site>/.netlify/functions/create-checkout?check=1  in a browser to see if everything is set up.
  let isCheck = false;
  try { isCheck = req.method === 'GET' && new URL(req.url).searchParams.get('check') === '1'; } catch (_) {}
  if (isCheck) {
    const key = env('STRIPE_SECRET_KEY');
    const out = {
      stripeKeySet: !!key,
      keyType: !key ? 'missing' : key.startsWith('sk_test_') ? 'test' : key.startsWith('sk_live_') ? 'live'
        : key.startsWith('pk_') ? 'WRONG: this is the publishable key, use the secret key' : key.startsWith('rk_') ? 'restricted' : 'not recognised',
      siteUrlSet: !!siteUrl,
      siteUrl: siteUrl || null
    };
    if (key) {
      try {
        const r = await fetch('https://api.stripe.com/v1/balance', { headers: { Authorization: `Bearer ${key}` } });
        out.stripeAcceptsKey = r.ok;
        out.stripeStatus = r.status;
      } catch (_) { out.stripeReachable = false; }
    }
    out.ready = out.stripeKeySet && out.siteUrlSet && out.stripeAcceptsKey === true;
    return reply(200, out);
  }

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  if (origin && !allowed.includes(origin)) return reply(403, { error: 'origin_not_allowed' });

  const secret = env('STRIPE_SECRET_KEY');
  if (!secret || !siteUrl) return reply(500, { error: 'not_configured' });

  // ---- read + validate the request -------------------------------------------------
  let raw;
  try { raw = await req.text(); } catch (_) { return reply(400, { error: 'bad_request' }); }
  if (raw.length > 12000) return reply(413, { error: 'too_large' });
  let b;
  try { b = JSON.parse(raw); } catch (_) { return reply(400, { error: 'bad_json' }); }
  if (!b || typeof b !== 'object') return reply(400, { error: 'bad_request' });

  if (b._gotcha) return reply(400, { error: 'bad_request' });           // bot trap

  if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > 10) return reply(400, { error: 'bad_items' });
  const qtyById = {};
  for (const it of b.items) {
    const id = clean(it && it.id, 60);
    const qty = Number(it && it.qty);
    if (!PRODUCTS[id] || !Number.isInteger(qty) || qty < 1 || qty > MAX_PER_ITEM) return reply(400, { error: 'bad_items' });
    qtyById[id] = (qtyById[id] || 0) + qty;
  }
  const ids = Object.keys(qtyById);
  if (ids.some((id) => qtyById[id] > MAX_PER_ITEM)) return reply(400, { error: 'bad_items' });

  const name = clean(b.name, 100);
  const email = clean(b.email, 254);
  const phone = clean(b.phone, 40);
  const fulfillment = clean(b.fulfillment, 20);
  const notes = clean(b.notes, 500);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, { error: 'bad_contact' });
  if (!FULFILLMENT.includes(fulfillment)) return reply(400, { error: 'bad_fulfillment' });

  let address = '';
  let delivery = null;
  if (fulfillment === 'delivery') {
    const a = b.address || {};
    const street = clean(a.street, 120), city = clean(a.city, 60), postal = clean(a.postal, 10);
    if (!street || !city || !/^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/.test(postal)) return reply(400, { error: 'bad_address' });
    address = `${street}, ${city} ${postal.toUpperCase()}`;
    delivery = { street, city, postal: postal.toUpperCase() };
  }

  // ---- tax settings ------------------------------------------------------------------------------
  const taxMode = (env('TAX_MODE') || 'none').trim().toLowerCase();
  if (!['none', 'stripe', 'fixed'].includes(taxMode)) return reply(500, { error: 'not_configured' });
  const taxBehavior = (env('TAX_BEHAVIOR') || 'exclusive').trim().toLowerCase() === 'inclusive' ? 'inclusive' : 'exclusive';
  const taxCode = (env('TAX_CODE') || '').trim();
  const fixedRate = Number(env('TAX_RATE_PERCENT') || 0);
  if (taxMode === 'fixed' && !(fixedRate > 0 && fixedRate < 30)) return reply(500, { error: 'not_configured' });
  const taxLabel = clean(env('TAX_LABEL') || 'HST', 30);

  // The price comes from THIS file, never from the browser. The browser only tells us what total
  // it showed the customer, so we can stop them paying a different amount than they saw.
  const itemsTotal = ids.reduce((n, id) => n + PRODUCTS[id].cents * qtyById[id], 0);
  if (Number(b.expected_total_cents) !== itemsTotal) return reply(409, { error: 'price_changed' });

  let orderId = clean(b.order_id, 30);
  if (!/^PM-\d{6}-[A-Z0-9]{4}$/.test(orderId)) {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    orderId = `PM-${String(d.getFullYear()).slice(2)}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X')}`;
  }

  // ---- ask Stripe for a checkout page ---------------------------------------------------
  const f = new URLSearchParams();
  f.set('mode', 'payment');
  f.set('success_url', `${siteUrl}/#paid`);
  f.set('cancel_url', `${siteUrl}/#order`);
  f.set('client_reference_id', orderId);

  const lineItem = (i, name, cents, qty) => {
    f.set(`line_items[${i}][quantity]`, String(qty));
    f.set(`line_items[${i}][price_data][currency]`, CURRENCY);
    f.set(`line_items[${i}][price_data][unit_amount]`, String(cents));
    f.set(`line_items[${i}][price_data][product_data][name]`, name);
    if (taxMode === 'stripe') {
      f.set(`line_items[${i}][price_data][tax_behavior]`, taxBehavior);
      if (taxCode) f.set(`line_items[${i}][price_data][product_data][tax_code]`, taxCode);
    }
  };

  let i = 0;
  const summary = [];
  for (const id of ids) {
    lineItem(i++, PRODUCTS[id].name, PRODUCTS[id].cents, qtyById[id]);
    summary.push(`${PRODUCTS[id].name} x${qtyById[id]}`);
  }
  const feeCents = fulfillment === 'delivery' ? DELIVERY_FEE_CENTS : 0;
  if (feeCents > 0) lineItem(i++, 'Local delivery', feeCents, 1);

  if (taxMode === 'fixed') {
    // one flat rate on everything the customer buys (items + any delivery fee)
    const taxCents = Math.round((itemsTotal + feeCents) * fixedRate / 100);
    if (taxCents > 0) lineItem(i++, `${taxLabel} (${fixedRate}%)`, taxCents, 1);
  }

  // Everything you need to fill the order shows up on the payment in your Stripe dashboard.
  const meta = { order_id: orderId, name, phone, fulfillment, address, notes, items: summary.join('; ') };
  for (const [k, v] of Object.entries(meta)) {
    if (!v) continue;
    f.set(`metadata[${k}]`, v);
    f.set(`payment_intent_data[metadata][${k}]`, v);
  }
  f.set('payment_intent_data[description]', `Order ${orderId}: ${summary.join('; ')} (${fulfillment})`);

  let data;
  try {
    if (taxMode === 'stripe') {
      f.set('automatic_tax[enabled]', 'true');
      // Stripe Tax needs to know where the sale happens: the delivery address, or your pickup address.
      const ship = delivery
        ? { line1: delivery.street, city: delivery.city, postal_code: delivery.postal }
        : (env('PICKUP_POSTAL') ? { line1: clean(env('PICKUP_STREET') || 'Pickup', 120), city: clean(env('PICKUP_CITY') || 'Sudbury', 60), postal_code: clean(env('PICKUP_POSTAL'), 10) } : null);
      if (ship) {
        const c = new URLSearchParams();
        c.set('email', email);
        c.set('name', name);
        if (phone) c.set('phone', phone);
        c.set('shipping[name]', name);
        c.set('shipping[address][line1]', ship.line1);
        c.set('shipping[address][city]', ship.city);
        c.set('shipping[address][state]', 'ON');
        c.set('shipping[address][postal_code]', ship.postal_code);
        c.set('shipping[address][country]', 'CA');
        const customer = await stripePost('customers', c, secret);
        f.set('customer', customer.id);
      } else {
        // no pickup address set: let Stripe ask the customer for a billing address and tax on that
        f.set('customer_email', email);
        f.set('billing_address_collection', 'required');
      }
    } else {
      f.set('customer_email', email);
    }
    data = await stripePost('checkout/sessions', f, secret);
  } catch (e) {
    console.error('Stripe error:', e && e.message);
    return reply(502, { error: 'payment_unavailable' });
  }
  if (!data || !data.url) {
    console.error('Stripe returned no url');
    return reply(502, { error: 'payment_unavailable' });
  }
  return reply(200, { url: data.url, order_id: orderId });
};
