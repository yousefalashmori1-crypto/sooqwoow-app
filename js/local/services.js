// Accounting workflows over the in-browser state. Mirrors src/services.ts (the PostgreSQL version) rule for rule.
import { LedgerError, buildReversal } from "../ledger.js";
import { buildSaleEntry, buildFullReturnEntries, buildReturnFeeEntry, chooseCarrier, normRegion, checkShipping, } from "../orders.js";
import { receive, issue, returnIn, proportionalCost, adjustTo, assertReceivable, buildPurchaseReceiptEntry, buildStockAdjustmentEntry, } from "../inventory.js";
import { buildReceipt, buildPayment, buildExpense, buildTransfer, assertSufficientFunds } from "../vouchers.js";
import { reconcile, buildCarrierSettlementEntry, classifyRow, extractOrderNo } from "../settlement.js";
import { classifyPayment, mapShippingMethod } from "../classify.js";
import { nid, post, net, sys, sysId, audit, today } from "./state.js";
const int = (v, what) => { const n = Number(v); if (!Number.isSafeInteger(n))
    throw new LedgerError(`${what} must be an integer`); return n; };
const posInt = (v, what) => { const n = int(v, what); if (n <= 0)
    throw new LedgerError(`${what} must be positive`); return n; };
const isoDate = (v, what = "date") => { const s = String(v ?? ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(s))
    throw new LedgerError(`${what} must be YYYY-MM-DD`); return s; };
const nf = (m) => Object.assign(new Error(m), { status: 404 });
// ---------- carriers
function carrierCfgs(S) {
    return S.carriers.filter((c) => c.active).map((c) => {
        const my = S.rates.filter((r) => r.carrier_id === c.id);
        const home = my.find((r) => r.delivery_type === "home" && r.region == null), office = my.find((r) => r.delivery_type === "office" && r.region == null);
        const regionCost = {};
        for (const r of my)
            if (r.region && r.delivery_type === "home")
                regionCost[normRegion(r.region)] = r.cost;
        return { id: c.id, key: c.key, name: c.name, partyId: c.party_id, supportsOffice: c.supports_office, settlementDays: c.settlement_days, returnFee: c.return_fee,
            coverage: c.coverage_all ? "all" : S.coverage.filter((x) => x.carrier_id === c.id && x.enabled).map((x) => x.region),
            homeCost: home ? home.cost : -1, officeCost: office?.cost, regionCost };
    });
}
function costFor(c, type, region) {
    if (type === "office") {
        if (!c.supportsOffice || c.officeCost == null)
            throw new LedgerError(`${c.name} لا تدعم التسليم للمكتب`);
        return c.officeCost;
    }
    const r = c.regionCost?.[normRegion(region)] ?? c.homeCost;
    if (r < 0)
        throw new LedgerError(`${c.name} ليس لها سعر توصيل للمنزل`);
    return r;
}
export function suggestCarrier(S, o) {
    const carriers = carrierCfgs(S).filter((c) => (o.deliveryType === "home" ? c.homeCost >= 0 : c.officeCost != null));
    const pick = chooseCarrier({ region: o.province, deliveryType: o.deliveryType, carriers });
    if (!pick)
        return null;
    return { carrierId: pick.carrier.id, carrierKey: pick.carrier.key, name: pick.carrier.name, cost: pick.cost,
        alternatives: pick.alternatives.map((a) => ({ carrierId: a.carrier.id, name: a.carrier.name, cost: a.cost })) };
}
// ---------- vouchers
export function createVoucher(S, b) {
    const box = S.cashboxes.find((c) => c.id === Number(b.cashboxId) && c.active);
    if (!box)
        throw new LedgerError("unknown cashbox");
    const common = { date: isoDate(b.date), cashboxAccountId: box.account_id, amount: Number(b.amount), note: b.note, idempotencyKey: b.idempotencyKey };
    let draft;
    let to;
    if (b.kind === "receipt")
        draft = buildReceipt({ ...common, receivableAccountId: Number(b.accountId), partyId: Number(b.partyId) });
    else if (b.kind === "payment")
        draft = buildPayment({ ...common, payableAccountId: Number(b.accountId), partyId: Number(b.partyId) });
    else if (b.kind === "expense")
        draft = buildExpense({ ...common, expenseAccountId: Number(b.accountId) });
    else if (b.kind === "transfer") {
        to = S.cashboxes.find((c) => c.id === Number(b.toCashboxId) && c.active);
        if (!to)
            throw new LedgerError("unknown destination cashbox");
        draft = buildTransfer({ date: common.date, fromAccountId: box.account_id, toAccountId: to.account_id, amount: common.amount, note: b.note, idempotencyKey: b.idempotencyKey });
    }
    else
        throw new LedgerError("unknown voucher kind");
    if (b.kind !== "receipt")
        assertSufficientFunds(net(S, box.account_id), common.amount, !!b.allowOverdraft);
    const posted = post(S, draft);
    if (!posted.duplicate) {
        S.vouchers.push({ id: nid(S, "vouchers"), kind: b.kind, voucher_date: common.date, cashbox_id: box.id, to_cashbox_id: to?.id ?? null, party_id: b.partyId ?? null, account_id: b.accountId ?? null, amount: common.amount, note: b.note ?? null, entry_id: posted.id });
        audit(S, "voucher.create", "journal_entries", posted.id);
    }
    return posted;
}
export function cashCount(S, b) {
    const box = S.cashboxes.find((c) => c.id === Number(b.cashboxId) && c.active);
    if (!box)
        throw new LedgerError("unknown cashbox");
    const counted = int(b.counted, "counted");
    if (counted < 0)
        throw new LedgerError("counted must be non-negative");
    const book = net(S, box.account_id), diff = counted - book, date = isoDate(b.date ?? today());
    let entryId = null;
    if (diff !== 0) {
        const d = sysId(S, "SETTLEMENT_DIFF"), amt = Math.abs(diff);
        entryId = post(S, { entryDate: date, description: diff > 0 ? "زيادة جرد الصندوق" : "عجز جرد الصندوق", sourceType: "cash_count",
            lines: diff > 0 ? [{ accountId: box.account_id, debit: amt }, { accountId: d, credit: amt }] : [{ accountId: d, debit: amt }, { accountId: box.account_id, credit: amt }] }).id;
    }
    S.cashCounts.push({ id: nid(S, "cashCounts"), cashbox_id: box.id, counted_on: date, book_balance: book, counted, entry_id: entryId });
    return { book, difference: diff, entryId };
}
// ---------- products
function ensureVariant(S, sku, title, variantTitle) {
    let v = sku ? S.variants.find((x) => x.sku === sku) : undefined;
    if (!v) {
        const p = S.products.find((x) => x.title === title);
        if (p)
            v = S.variants.find((x) => x.product_id === p.id && (x.title === (variantTitle ?? "Default")));
    }
    if (v)
        return v;
    let p = S.products.find((x) => x.title === title);
    if (!p) {
        p = { id: nid(S, "products"), title, fulfillment: "stock", default_supplier_id: null, active: true };
        S.products.push(p);
    }
    v = { id: nid(S, "variants"), product_id: p.id, sku, title: variantTitle ?? "Default", fulfillment: null, default_cost: null, supplier_id: null, reorder_level: 0, active: true };
    S.variants.push(v);
    return v;
}
export function updateVariant(S, id, b) {
    const v = S.variants.find((x) => x.id === id);
    if (!v)
        throw nf("variant not found");
    v.fulfillment = b.fulfillment || null;
    v.default_cost = b.defaultCost ?? null;
    v.supplier_id = b.supplierId ?? null;
    if (b.reorderLevel != null)
        v.reorder_level = Number(b.reorderLevel);
    if (b.productFulfillment) {
        const p = S.products.find((x) => x.id === v.product_id);
        p.fulfillment = b.productFulfillment;
        if (b.productSupplierId)
            p.default_supplier_id = b.productSupplierId;
    }
    audit(S, "variant.update", "variants", id);
    return { ok: true };
}
const stockOf = (S, vid) => S.stock[vid] ?? { qty: 0, value: 0 };
const moveStock = (S, variantId, kind, qty, value, entryId, refType, refId) => S.movements.push({ id: nid(S, "movements"), variant_id: variantId, kind, qty_delta: qty, value_delta: value, ref_type: refType, ref_id: refId, entry_id: entryId, created_at: new Date().toISOString() });
const fulfil = (S, v) => v.fulfillment ?? S.products.find((p) => p.id === v.product_id).fulfillment;
export function listProducts(S) {
    return S.variants.filter((v) => v.active).map((v) => {
        const p = S.products.find((x) => x.id === v.product_id), st = stockOf(S, v.id);
        return { variant_id: v.id, product_id: p.id, title: p.title, variant: v.title, sku: v.sku, fulfillment: fulfil(S, v), variant_fulfillment: v.fulfillment, product_fulfillment: p.fulfillment,
            supplier_id: v.supplier_id ?? p.default_supplier_id, default_cost: v.default_cost, reorder_level: v.reorder_level, qty: st.qty, value: st.value };
    }).sort((a, b) => (a.title + a.variant).localeCompare(b.title + b.variant, "ar"));
}
export function openingStock(S, b) {
    const date = isoDate(b.date);
    let total = 0;
    const moves = [];
    for (const l of b.lines ?? []) {
        const vid = posInt(l.variantId, "variantId");
        if (!S.variants.some((v) => v.id === vid))
            throw new LedgerError("variant unknown");
        const r = receive(stockOf(S, vid), posInt(l.qty, "qty"), int(l.unitCost, "unitCost"));
        S.stock[vid] = r.state;
        total += r.value;
        moves.push({ vid, qty: Number(l.qty), value: r.value });
    }
    if (total <= 0)
        throw new LedgerError("قيمة المخزون الافتتاحي صفر");
    const e = post(S, { entryDate: date, description: "مخزون افتتاحي", sourceType: "opening_stock", lines: [{ accountId: sysId(S, "INVENTORY"), debit: total }, { accountId: sysId(S, "CAPITAL"), credit: total }] });
    for (const m of moves)
        moveStock(S, m.vid, "opening", m.qty, m.value, e.id, null, null);
    return { entryId: e.id, total };
}
export function stockCount(S, b) {
    const date = isoDate(b.date);
    const c = { id: nid(S, "counts"), counted_on: date, note: b.note ?? null, lines: [] };
    S.counts.push(c);
    const sy = sys(S, ["INV_SHRINKAGE"]);
    const netBy = new Map();
    const moves = [];
    for (const l of b.lines ?? []) {
        const vid = posInt(l.variantId, "variantId");
        const v = S.variants.find((x) => x.id === vid);
        if (!v)
            throw new LedgerError(`variant ${vid} unknown`);
        const reason = ["damaged", "lost", "count_difference"].includes(l.reason) ? l.reason : "count_difference";
        const st = stockOf(S, vid);
        const r = adjustTo(st, int(l.countedQty, "countedQty"), v.default_cost ?? 0);
        c.lines.push({ variant_id: vid, book_qty: st.qty, counted_qty: l.countedQty, reason: r.qtyDelta === 0 ? null : reason });
        if (r.qtyDelta === 0)
            continue;
        S.stock[vid] = r.state;
        moves.push({ vid, qty: r.qtyDelta, value: r.valueDelta });
        const acct = reason === "damaged" ? sy.INV_DAMAGED : sy.INV_SHRINKAGE;
        netBy.set(acct, (netBy.get(acct) ?? 0) + r.valueDelta);
    }
    let entryId = null;
    for (const [acct, delta] of netBy) {
        const d = buildStockAdjustmentEntry({ date, inventoryAccountId: sy.INVENTORY, lossAccountId: acct, valueDelta: delta, note: `جرد مخزون #${c.id}` });
        if (d) {
            d.sourceId = c.id;
            entryId = post(S, d).id;
        }
    }
    for (const m of moves)
        moveStock(S, m.vid, "adjustment", m.qty, m.value, entryId, "stock_count", c.id);
    return { countId: c.id, adjusted: moves.length };
}
// ---------- purchasing
export function createPurchase(S, b) {
    const sup = S.parties.find((p) => p.id === Number(b.supplierId) && p.kinds.includes("supplier"));
    if (!sup)
        throw new LedgerError("المورد غير صالح");
    if (!Array.isArray(b.lines) || !b.lines.length)
        throw new LedgerError("أضف بندًا واحدًا على الأقل");
    const inv = { id: nid(S, "purchases"), supplier_id: sup.id, invoice_no: b.invoiceNo ?? null, invoice_date: isoDate(b.date ?? today()), payment_terms: b.terms === "cash" ? "cash" : "credit", status: "open", note: b.note ?? null };
    for (const l of b.lines) {
        const vid = posInt(l.variantId, "variantId");
        if (!S.variants.some((v) => v.id === vid))
            throw new LedgerError("variant unknown");
        S.pLines.push({ id: nid(S, "pLines"), invoice_id: inv.id, variant_id: vid, qty_ordered: posInt(l.qty, "qty"), qty_received: 0, unit_cost: int(l.unitCost, "unitCost") });
    }
    S.purchases.push(inv);
    audit(S, "purchase.create", "purchase_invoices", inv.id);
    return { id: inv.id };
}
export function receivePurchase(S, id, b) {
    const inv = S.purchases.find((p) => p.id === id);
    if (!inv)
        throw nf("invoice not found");
    if (inv.status === "cancelled")
        throw new LedgerError("الفاتورة ملغاة");
    const date = isoDate(b.date ?? today());
    const sy = sys(S);
    const lines = S.pLines.filter((l) => l.invoice_id === id);
    const want = b.lines ?? lines.map((l) => ({ lineId: l.id, qty: l.qty_ordered - l.qty_received })).filter((x) => x.qty > 0);
    if (!want.length)
        throw new LedgerError("لا توجد كميات للاستلام");
    let amount = 0;
    const moves = [];
    for (const w of want) {
        const l = lines.find((x) => x.id === Number(w.lineId));
        if (!l)
            throw new LedgerError("بند غير موجود في الفاتورة");
        const q = posInt(w.qty, "qty");
        assertReceivable(l.qty_ordered, l.qty_received, q);
        const r = receive(stockOf(S, l.variant_id), q, l.unit_cost);
        S.stock[l.variant_id] = r.state;
        l.qty_received += q;
        const v = S.variants.find((x) => x.id === l.variant_id);
        if (fulfil(S, v) === "stock")
            v.default_cost = l.unit_cost;
        amount += r.value;
        moves.push({ vid: l.variant_id, qty: q, value: r.value });
    }
    const entry = post(S, buildPurchaseReceiptEntry({ date, inventoryAccountId: sy.INVENTORY, payableAccountId: sy.AP_SUPPLIERS, supplierId: inv.supplier_id, amount, invoiceId: id, note: `استلام بضاعة${inv.invoice_no ? ` - فاتورة ${inv.invoice_no}` : ` #${id}`}` }));
    for (const m of moves)
        moveStock(S, m.vid, "purchase", m.qty, m.value, entry.id, "purchase_invoice", id);
    S.receipts.push({ id: nid(S, "receipts"), invoice_id: id, received_on: date, entry_id: entry.id });
    const left = S.pLines.filter((l) => l.invoice_id === id && l.qty_received < l.qty_ordered).length;
    if (left === 0)
        inv.status = "received";
    let payment = null;
    if (b.payCashboxId)
        payment = createVoucher(S, { kind: "payment", date, cashboxId: b.payCashboxId, amount, partyId: inv.supplier_id, accountId: sy.AP_SUPPLIERS, note: `دفع فاتورة مشتريات #${id}`, allowOverdraft: !!b.allowOverdraft });
    audit(S, "purchase.receive", "purchase_invoices", id, { amount });
    return { entryId: entry.id, amount, complete: left === 0, payment };
}
export function cancelPurchase(S, id) {
    const inv = S.purchases.find((p) => p.id === id);
    if (!inv)
        throw nf("invoice not found");
    if (S.pLines.some((l) => l.invoice_id === id && l.qty_received > 0))
        throw new LedgerError("لا يمكن إلغاء فاتورة استُلم جزء منها");
    inv.status = "cancelled";
    return { ok: true };
}
// ---------- orders
export function orderIssues(S, p) {
    const issues = [];
    const method = classifyPayment(p.gatewayNames, S.settings.payment_map ?? {});
    if (!method)
        issues.push("payment_method_unknown");
    const ship = mapShippingMethod(p.shippingTitle, S.shipMap.map((m) => ({ match: m.title_match, carrierKey: S.carriers.find((c) => c.id === m.carrier_id)?.key, deliveryType: m.delivery_type })));
    if (!ship)
        issues.push("shipping_method_unmapped");
    if (!p.province)
        issues.push("province_missing");
    if (p.countryCode)
        issues.push(...checkShipping({ totalAfterDiscount: p.goodsTotal, shippingCharged: p.shippingCharged, countryCode: p.countryCode, threshold: S.settings.free_shipping_threshold_baisa }));
    else
        issues.push("country_missing");
    return { issues, method, ship };
}
/** Import orders (from the Shopify orders CSV). Existing order numbers are skipped, so re-importing the same file is harmless. */
export function importOrders(S, list) {
    let added = 0, skipped = 0, review = 0, cancelled = 0, created = 0;
    for (const p of list) {
        if (S.orders.some((o) => o.order_no === p.orderNo)) {
            skipped++;
            continue;
        }
        if (p.cancelled) {
            cancelled++;
            continue;
        }
        const { issues, method, ship } = orderIssues(S, p);
        const before = S.variants.length;
        const status = issues.length ? "needs_review" : method === "transfer" ? "awaiting_payment" : "new";
        const o = { id: nid(S, "orders"), shopify_order_id: p.shopifyOrderId, order_no: p.orderNo, ordered_at: p.orderedAt, status, payment_method: method, customer_id: null,
            province: p.province, country_code: p.countryCode, delivery_type: ship?.deliveryType ?? null, carrier_id: null, awb: null, goods_total: p.goodsTotal, discount: p.discount,
            shipping_charged: p.shippingCharged, carrier_cost: null, gateway_fee: 0, review_reason: issues.join(",") || null, sale_entry_id: null, customer_name: p.customerName || null,
            phone: p.phone, handed_on: null, delivered_on: null, return_fee: null, note: null };
        S.orders.push(o);
        for (const l of p.lines) {
            const v = ensureVariant(S, l.sku, l.title, l.variantTitle);
            S.oLines.push({ id: nid(S, "oLines"), order_id: o.id, variant_id: v.id, qty: l.qty, unit_price: l.unitPrice, fulfillment: null, cost_total: null, supplier_id: null });
        }
        created += S.variants.length - before;
        added++;
        if (issues.length)
            review++;
    }
    audit(S, "orders.import", "orders", null, { added, skipped });
    return { added, skipped, review, cancelled, newProducts: created };
}
const getOrder = (S, id) => { const o = S.orders.find((x) => x.id === id); if (!o)
    throw nf("order not found"); return o; };
export function orderDetail(S, id) {
    const o = getOrder(S, id);
    const lines = S.oLines.filter((l) => l.order_id === id).map((l) => {
        const v = S.variants.find((x) => x.id === l.variant_id), p = v && S.products.find((x) => x.id === v.product_id);
        return { id: l.id, variant_id: l.variant_id, qty: l.qty, unit_price: l.unit_price, cost_total: l.cost_total, title: p?.title, variant: v?.title, fulfillment: v ? (l.fulfillment ?? fulfil(S, v)) : null, supplier_id: v ? (l.supplier_id ?? v.supplier_id ?? p.default_supplier_id) : null };
    });
    const suggestion = o.delivery_type && o.province ? suggestCarrier(S, { province: o.province, deliveryType: o.delivery_type }) : null;
    const car = o.carrier_id ? S.carriers.find((c) => c.id === o.carrier_id) : null;
    return { order: { ...o, carrier: car?.name ?? null }, lines, suggestion, profit: orderProfit(S, id) };
}
export function orderProfit(S, orderId) {
    const ids = new Set(S.entries.filter((e) => e.source_id === orderId && String(e.source_type).startsWith("order_")).map((e) => e.id));
    let p = 0;
    for (const l of S.lines)
        if (ids.has(l.entry_id)) {
            const t = S.accounts.find((a) => a.id === l.account_id).type;
            if (t === "revenue" || t === "expense")
                p += l.credit - l.debit;
        }
    return ids.size ? p : 0;
}
export function resolveOrder(S, id, b) {
    const o = getOrder(S, id);
    if (o.status !== "needs_review")
        throw new LedgerError("الطلب ليس بحالة مراجعة");
    const method = b.paymentMethod ?? o.payment_method;
    if (!["cod", "gateway", "transfer"].includes(method))
        throw new LedgerError("حدد طريقة الدفع");
    const dt = b.deliveryType ?? o.delivery_type;
    if (!["home", "office"].includes(dt))
        throw new LedgerError("حدد نوع التوصيل");
    const province = String(b.province ?? o.province ?? "").trim();
    if (!province)
        throw new LedgerError("حدد المنطقة");
    const country = String(b.countryCode ?? o.country_code ?? "").toUpperCase();
    if (!country)
        throw new LedgerError("حدد الدولة");
    const shipping = b.shippingCharged != null ? int(b.shippingCharged, "shippingCharged") : o.shipping_charged;
    if (country === "OM") {
        const free = o.goods_total >= S.settings.free_shipping_threshold_baisa;
        if (((free && shipping > 0) || (!free && shipping === 0)) && !b.confirmShipping)
            throw new LedgerError("الشحن لا يطابق قاعدة الشحن المجاني (25 ر.ع). أكّد المبلغ صراحة أو صحّحه");
    }
    Object.assign(o, { payment_method: method, delivery_type: dt, province, country_code: country, shipping_charged: shipping, review_reason: null, status: method === "transfer" ? "awaiting_payment" : "new", note: b.note ?? o.note });
    audit(S, "order.resolve", "orders", id);
    return { ok: true };
}
export function confirmTransfer(S, id, b) {
    const o = getOrder(S, id);
    if (o.status !== "awaiting_payment")
        throw new LedgerError("الطلب ليس بانتظار التحويل");
    if (!o.customer_id) {
        const pid = nid(S, "parties");
        S.parties.push({ id: pid, name: o.customer_name || `عميل طلب ${o.order_no}`, kinds: ["customer"], phone: o.phone, notes: null, active: true });
        o.customer_id = pid;
    }
    o.status = "new";
    let receipt = null;
    if (b.cashboxId)
        receipt = createVoucher(S, { kind: "receipt", date: isoDate(b.date ?? today()), cashboxId: b.cashboxId, amount: o.goods_total + o.shipping_charged, partyId: o.customer_id, accountId: sysId(S, "AR_CUSTOMERS"), note: `تحويل طلب ${o.order_no}`, idempotencyKey: `order:${id}:transfer_receipt` });
    return { customerId: o.customer_id, receipt };
}
function recognizeSale(S, o, date) {
    if (o.sale_entry_id)
        return { entryId: o.sale_entry_id, warnings: [] };
    if (!o.carrier_id || o.carrier_cost == null)
        throw new LedgerError("حدد شركة الشحن أولًا");
    const lines = S.oLines.filter((l) => l.order_id === o.id);
    if (!lines.length)
        throw new LedgerError("الطلب بلا منتجات");
    const warnings = [];
    const costOf = new Map();
    const dropship = new Map();
    const states = new Map();
    const moves = [];
    let stockCogs = 0;
    for (const l of lines) {
        const v = S.variants.find((x) => x.id === l.variant_id), p = S.products.find((x) => x.id === v.product_id), ful = l.fulfillment ?? fulfil(S, v), sup = l.supplier_id ?? v.supplier_id ?? p.default_supplier_id;
        if (ful === "dropship") {
            if (sup == null)
                throw new LedgerError(`المنتج «${p.title}» دروب شيبينغ بلا مورد`);
            if (v.default_cost == null)
                throw new LedgerError(`المنتج «${p.title}» بلا تكلفة`);
            const c = v.default_cost * l.qty;
            costOf.set(l.id, c);
            dropship.set(sup, (dropship.get(sup) ?? 0) + c);
        }
        else {
            if (!states.has(v.id))
                states.set(v.id, { ...stockOf(S, v.id) });
            const st = states.get(v.id);
            const take = Math.min(st.qty, l.qty);
            let cost = 0;
            if (take > 0) {
                const r = issue(st, take);
                states.set(v.id, r.state);
                cost += r.cost;
                moves.push({ vid: v.id, lineId: l.id, qty: -take, value: -r.cost });
            }
            const short = l.qty - take;
            if (short > 0) {
                if (v.default_cost == null)
                    throw new LedgerError(`مخزون «${p.title}» غير كافٍ (${take} من ${l.qty}) ولا توجد تكلفة افتراضية: أدخل رصيدًا افتتاحيًا أو تكلفة`);
                cost += short * v.default_cost;
                warnings.push(`مخزون «${p.title}» غير كافٍ: سُجّل ${short} وحدة بالتكلفة الافتراضية. صحّح الجرد.`);
            }
            costOf.set(l.id, cost);
            stockCogs += cost;
        }
    }
    const sy = sys(S);
    const car = S.carriers.find((c) => c.id === o.carrier_id);
    const gw = o.payment_method === "gateway" ? S.parties.find((p) => p.kinds.includes("gateway") && p.active) : null;
    if (o.payment_method === "gateway" && !gw)
        throw new LedgerError("لا يوجد طرف من نوع بوابة دفع");
    if (o.payment_method === "transfer" && !o.customer_id)
        throw new LedgerError("أكّد التحويل أولًا (إنشاء العميل)");
    const posted = post(S, buildSaleEntry({ orderId: o.id, orderNo: String(o.order_no), date, method: o.payment_method, goodsTotal: o.goods_total, shippingCharged: o.shipping_charged, carrierCost: o.carrier_cost,
        carrierPartyId: car.party_id, customerPartyId: o.customer_id ?? undefined, gatewayPartyId: gw?.id, gatewayFee: o.gateway_fee ?? 0, stockCogs,
        dropship: [...dropship].map(([supplierId, cost]) => ({ supplierId, cost })) }, sy));
    for (const m of moves)
        moveStock(S, m.vid, "sale", m.qty, m.value, posted.id, "order_line", m.lineId);
    for (const [vid, s] of states)
        S.stock[vid] = s;
    for (const l of lines) {
        const v = S.variants.find((x) => x.id === l.variant_id), p = S.products.find((x) => x.id === v.product_id);
        l.cost_total = costOf.get(l.id) ?? 0;
        l.fulfillment = l.fulfillment ?? fulfil(S, v);
        l.supplier_id = l.fulfillment === "dropship" ? (l.supplier_id ?? v.supplier_id ?? p.default_supplier_id) : null;
    }
    o.sale_entry_id = posted.id;
    return { entryId: posted.id, warnings };
}
export function handoverOrder(S, id, b) {
    const o = getOrder(S, id);
    if (o.status !== "new")
        throw new LedgerError(o.status === "awaiting_payment" ? "أكّد التحويل أولًا" : `لا يمكن التسليم من حالة ${o.status}`);
    if (!o.delivery_type || !o.province)
        throw new LedgerError("نوع التوصيل أو المنطقة ناقصة");
    const carriers = carrierCfgs(S);
    let carrier, cost;
    if (b.carrierId) {
        carrier = carriers.find((c) => c.id === Number(b.carrierId));
        if (!carrier)
            throw new LedgerError("شركة شحن غير معروفة");
        cost = b.carrierCost != null ? int(b.carrierCost, "carrierCost") : costFor(carrier, o.delivery_type, o.province);
    }
    else {
        const pick = suggestCarrier(S, { province: o.province, deliveryType: o.delivery_type });
        if (!pick)
            throw new LedgerError("لا توجد شركة شحن تغطي هذه المنطقة");
        carrier = carriers.find((c) => c.id === pick.carrierId);
        cost = b.carrierCost != null ? int(b.carrierCost, "carrierCost") : pick.cost;
    }
    if (cost < 0)
        throw new LedgerError("تكلفة الشحن غير صالحة");
    const awb = b.awb ? String(b.awb).trim() : null;
    const date = isoDate(b.date ?? today());
    if (awb && S.orders.some((x) => x.awb === awb && x.id !== id))
        throw new LedgerError("رقم الشحنة (AWB) مستخدم لطلب آخر");
    Object.assign(o, { carrier_id: carrier.id, carrier_cost: cost, awb, status: "handed_to_carrier", handed_on: date });
    if (b.gatewayFee != null)
        o.gateway_fee = int(b.gatewayFee, "gatewayFee");
    let warnings = [];
    if (o.payment_method !== "cod")
        warnings = recognizeSale(S, o, date).warnings;
    audit(S, "order.handover", "orders", id, { carrier: carrier.key, cost });
    return { carrier: carrier.name, cost, warnings };
}
export function deliverOrder(S, id, b = {}) {
    const o = getOrder(S, id);
    if (o.status === "delivered")
        return { ok: true, already: true, warnings: [] };
    if (o.status !== "handed_to_carrier")
        throw new LedgerError(`لا يمكن التوصيل من حالة ${o.status}`);
    const date = isoDate(b.date ?? today());
    let warnings = [];
    if (o.payment_method === "cod")
        warnings = recognizeSale(S, o, date).warnings;
    o.status = "delivered";
    o.delivered_on = date;
    audit(S, "order.deliver", "orders", id);
    return { ok: true, warnings };
}
export function cancelOrder(S, id, b = {}) {
    const o = getOrder(S, id);
    if (o.sale_entry_id || ["handed_to_carrier", "delivered", "returned"].includes(o.status))
        throw new LedgerError("لا يمكن إلغاء طلب سُلِّم للشركة: استخدم المرتجع");
    o.status = "cancelled";
    if (b.note)
        o.note = b.note;
    return { ok: true };
}
export function returnOrder(S, id, b = {}) {
    const o = getOrder(S, id);
    if (o.status === "returned")
        return { ok: true, already: true };
    if (!["handed_to_carrier", "delivered"].includes(o.status))
        throw new LedgerError(`لا يمكن إرجاع طلب بحالة ${o.status}`);
    const date = isoDate(b.date ?? today());
    const sy = sys(S);
    const car = S.carriers.find((c) => c.id === o.carrier_id);
    const fee = b.fee != null ? int(b.fee, "fee") : car.return_fee;
    if (fee < 0)
        throw new LedgerError("رسم الرجوع غير صالح");
    const entries = [];
    if (!o.sale_entry_id) {
        const e = buildReturnFeeEntry({ orderId: id, orderNo: String(o.order_no), date, fee, carrierPartyId: car.party_id }, sy);
        if (e)
            entries.push(post(S, e).id);
    }
    else {
        const saleLines = S.lines.filter((l) => l.entry_id === o.sale_entry_id).sort((a, c) => a.line_no - c.line_no).map((l) => ({ accountId: l.account_id, partyId: l.party_id, debit: l.debit, credit: l.credit }));
        const damaged = new Map((b.damaged ?? []).map((d) => [Number(d.lineId), Number(d.qty)]));
        let damagedCost = 0;
        const backs = [];
        for (const l of S.oLines.filter((x) => x.order_id === id)) {
            if (l.fulfillment !== "stock")
                continue;
            const dq = damaged.get(l.id) ?? 0;
            if (dq < 0 || dq > l.qty)
                throw new LedgerError("كمية التالف غير صالحة");
            const total = l.cost_total ?? 0, dcost = dq > 0 ? proportionalCost(total, l.qty, dq) : 0;
            damagedCost += dcost;
            if (l.qty - dq > 0)
                backs.push({ vid: l.variant_id, qty: l.qty - dq, cost: total - dcost });
        }
        const drafts = buildFullReturnEntries({ orderId: id, orderNo: String(o.order_no), date, saleEntryId: o.sale_entry_id, saleLines, fee, carrierPartyId: car.party_id, damagedCost }, sy);
        for (const d of drafts)
            entries.push(post(S, d).id);
        for (const bk of backs) {
            S.stock[bk.vid] = returnIn(stockOf(S, bk.vid), bk.qty, bk.cost);
            moveStock(S, bk.vid, "sale_return", bk.qty, bk.cost, entries[0], "order", id);
        }
    }
    o.status = "returned";
    o.return_fee = fee;
    audit(S, "order.return", "orders", id, { fee });
    return { ok: true, entries };
}
// ---------- carrier settlement
function expectedOrders(S, carrierId) {
    return new Map(S.orders.filter((o) => o.carrier_id === carrierId && ["handed_to_carrier", "delivered"].includes(o.status)).map((o) => [String(o.order_no),
        { orderNo: String(o.order_no), method: o.payment_method === "cod" ? "cod" : "prepaid", expectedCod: o.goods_total + o.shipping_charged }]));
}
export const previewSettlement = (S, b) => reconcile(b.rows, int(b.received, "received"), expectedOrders(S, Number(b.carrierId)));
export function commitSettlement(S, b) {
    const carrier = S.carriers.find((c) => c.id === Number(b.carrierId));
    if (!carrier)
        throw new LedgerError("شركة الشحن غير معروفة");
    const hash = String(b.fileHash ?? "");
    if (!/^[a-f0-9]{16,64}$/i.test(hash))
        throw new LedgerError("بصمة الملف مفقودة");
    if (S.settlements.some((s) => s.file_hash === hash))
        throw new LedgerError("هذا الكشف سُجّل من قبل");
    const date = isoDate(b.transferDate), received = int(b.received, "received"), rows = b.rows;
    const box = S.cashboxes.find((c) => c.id === Number(b.cashboxId) && c.active);
    if (!box)
        throw new LedgerError("اختر الصندوق/البنك المستلم");
    const rec = previewSettlement(S, { carrierId: carrier.id, rows, received });
    const touched = [];
    for (const m of [...rec.matched, ...rec.differences.map((d) => ({ row: d.row, orderNo: d.orderNo }))]) {
        if (!m.orderNo)
            continue;
        const o = S.orders.find((x) => x.order_no === m.orderNo && x.carrier_id === carrier.id);
        if (!o)
            continue;
        const kind = classifyRow(m.row);
        if (m.row.barcode && !o.awb && !S.orders.some((x) => x.awb === m.row.barcode))
            o.awb = m.row.barcode;
        if ((kind === "cod_delivered" || kind === "prepaid_delivered") && o.status === "handed_to_carrier") {
            deliverOrder(S, o.id, { date });
            touched.push(`${m.orderNo}:delivered`);
        }
        else if (kind === "returned" && o.status === "handed_to_carrier") {
            returnOrder(S, o.id, { date, fee: m.row.shippingPrice });
            touched.push(`${m.orderNo}:returned`);
        }
    }
    const sy = sys(S, ["SETTLEMENT_DIFF"]);
    const accepted = b.acceptedDifference != null ? int(b.acceptedDifference, "acceptedDifference") : 0;
    const posted = post(S, buildCarrierSettlementEntry({ date, bankAccountId: box.account_id, receivableAccountId: sy.AR_CARRIERS, payableAccountId: sy.AP_CARRIERS, diffAccountId: sy.SETTLEMENT_DIFF,
        carrierPartyId: carrier.party_id, received, prepaidShipping: rec.prepaidShipping, acceptedDifference: accepted, fileHash: hash, carrierKey: carrier.key }));
    const s = { id: nid(S, "settlements"), carrier_id: carrier.id, transfer_date: date, file_name: b.fileName ?? null, file_hash: hash, received, expected: rec.expectedNet, difference: received - rec.expectedNet, entry_id: posted.id };
    S.settlements.push(s);
    const diffNos = new Set(rec.differences.map((d) => d.row.barcode)), unk = new Set(rec.unknownOrders.map((d) => d.barcode));
    for (const r of rows) {
        const no = extractOrderNo(r.note);
        S.sLines.push({ settlement_id: s.id, order_id: S.orders.find((o) => o.order_no === no)?.id ?? null, awb: r.barcode, status: r.status, cod: r.cod, shipping_price: r.shippingPrice, match: unk.has(r.barcode) ? "unknown_order" : diffNos.has(r.barcode) ? "difference" : "matched" });
    }
    audit(S, "settlement.commit", "carrier_settlements", s.id, { received, difference: rec.difference, accepted });
    return { settlementId: s.id, entryId: posted.id, difference: rec.difference, openDifference: -(rec.difference + accepted), touched };
}
export { buildReversal, normRegion };
