// The whole "server" running inside the browser. handle(method, path, body) answers the same /api routes as the PostgreSQL version.
// Every mutating call runs on a snapshot: if anything throws, the books are restored exactly as they were (all-or-nothing).
import { LedgerError, buildReversal } from "../ledger.js";
import { seed, post, today, nid } from "./state.js";
import * as S_ from "./services.js";
import { parseShopifyOrdersCsv } from "./shopify-csv.js";
const SETTING_KEYS = new Set(["payment_map", "free_shipping_threshold_baisa"]);
const badId = (s) => { const n = Number(s); if (!Number.isSafeInteger(n) || n <= 0)
    throw Object.assign(new LedgerError("bad id"), { status: 400 }); return n; };
const sum = (a) => a.reduce((x, y) => x + y, 0);
const nf = (m) => Object.assign(new Error(m), { status: 404 });
export async function createBackend(storage) {
    const raw = await storage.load();
    let S = raw ? JSON.parse(raw) : seed();
    if (!raw)
        await storage.save(JSON.stringify(S));
    const acct = (id) => S.accounts.find((a) => a.id === id);
    const key = (k) => S.accounts.find((a) => a.system_key === k)?.id;
    const party = (id) => (id == null ? null : S.parties.find((p) => p.id === id));
    /** Sums journal lines grouped by a key, with the entry + account attached. */
    function lineRows() {
        const eById = new Map(S.entries.map((e) => [e.id, e]));
        return S.lines.map((l) => ({ ...l, e: eById.get(l.entry_id), a: acct(l.account_id) }));
    }
    const sortedEntries = () => [...S.entries].sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : a.id - b.id));
    function statement(filter) {
        const rows = lineRows().filter(filter).sort((x, y) => (x.e.entry_date < y.e.entry_date ? -1 : x.e.entry_date > y.e.entry_date ? 1 : x.entry_id - y.entry_id || x.line_no - y.line_no));
        let run = 0;
        return rows.map((l) => {
            run += l.debit - l.credit;
            return { party_id: l.party_id, account_id: l.account_id, entry_id: l.entry_id, entry_date: l.e.entry_date, description: l.e.description, source_type: l.e.source_type, debit: l.debit, credit: l.credit, running_net_debit: run, account: l.a.name_ar };
        });
    }
    function balances() {
        const m = new Map();
        for (const l of S.lines)
            m.set(l.account_id, (m.get(l.account_id) ?? 0) + l.debit - l.credit);
        return m;
    }
    const cashboxList = () => { const b = balances(); return S.cashboxes.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name, kind: c.kind, account_id: c.account_id, balance: b.get(c.account_id) ?? 0 })); };
    function carrierPending() {
        const arC = key("AR_CARRIERS"), apC = key("AP_CARRIERS");
        return S.parties.filter((p) => p.kinds.includes("carrier")).map((p) => {
            const ls = S.lines.filter((l) => l.party_id === p.id);
            return { party_id: p.id, name: p.name, they_owe_us: sum(ls.filter((l) => l.account_id === arC).map((l) => l.debit - l.credit)), we_owe_them: sum(ls.filter((l) => l.account_id === apC).map((l) => l.credit - l.debit)) };
        }).filter((r) => S.lines.some((l) => l.party_id === r.party_id)).sort((a, b) => a.name.localeCompare(b.name, "ar"));
    }
    const supplierBalances = () => {
        const ap = key("AP_SUPPLIERS");
        return S.parties.map((p) => ({ party_id: p.id, name: p.name, we_owe: sum(S.lines.filter((l) => l.party_id === p.id && l.account_id === ap).map((l) => l.credit - l.debit)) }))
            .filter((r) => S.lines.some((l) => l.party_id === r.party_id && l.account_id === ap)).sort((a, b) => b.we_owe - a.we_owe);
    };
    const monthly = () => {
        const by = new Map();
        for (const l of lineRows()) {
            const t = l.a.type;
            if (t !== "revenue" && t !== "expense")
                continue;
            const m = l.e.entry_date.slice(0, 7) + "-01";
            const r = by.get(m) ?? { month: m, revenue: 0, expenses: 0, profit: 0 };
            by.set(m, r);
            if (t === "revenue")
                r.revenue += l.credit - l.debit;
            else
                r.expenses += l.debit - l.credit;
            r.profit += l.credit - l.debit;
        }
        return [...by.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
    };
    const stockRows = () => S.variants.filter((v) => v.active).map((v) => {
        const p = S.products.find((x) => x.id === v.product_id), s = S.stock[v.id] ?? { qty: 0, value: 0 };
        return { variant_id: v.id, title: p.title, variant: v.title, qty: s.qty, value: s.value, avg_cost: s.qty > 0 ? Math.round(s.value / s.qty) : null, reorder_level: v.reorder_level, low: s.qty <= v.reorder_level };
    })
        .sort((a, b) => (a.title + a.variant).localeCompare(b.title + b.variant, "ar"));
    function report(name) {
        switch (name) {
            case "daily_sales": {
                const by = new Map();
                for (const l of lineRows()) {
                    const k = l.a.system_key;
                    if (!["SALES", "SALES_RETURNS", "SHIPPING_REVENUE", "COGS"].includes(k))
                        continue;
                    const r = by.get(l.e.entry_date) ?? { day: l.e.entry_date, net_sales: 0, shipping_revenue: 0, cogs: 0 };
                    by.set(l.e.entry_date, r);
                    if (k === "SALES")
                        r.net_sales += l.credit - l.debit;
                    else if (k === "SALES_RETURNS")
                        r.net_sales -= l.debit - l.credit;
                    else if (k === "SHIPPING_REVENUE")
                        r.shipping_revenue += l.credit - l.debit;
                    else
                        r.cogs += l.debit - l.credit;
                }
                return [...by.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 366);
            }
            case "monthly_pnl": return monthly().slice(0, 60);
            case "order_profit": return [...S.orders].sort((a, b) => (a.ordered_at < b.ordered_at ? 1 : -1)).slice(0, 500).map((o) => ({ order_id: o.id, order_no: o.order_no, ordered_at: o.ordered_at, status: o.status, carrier_id: o.carrier_id, profit: S_.orderProfit(S, o.id) ?? 0 }));
            case "carrier_pending": return carrierPending();
            case "carrier_aging": {
                const ar = key("AR_CARRIERS"), now = Date.parse(today());
                const by = new Map();
                for (const l of lineRows()) {
                    if (l.account_id !== ar || l.e.source_type === "carrier_settlement" || l.party_id == null)
                        continue;
                    const age = Math.round((now - Date.parse(l.e.entry_date)) / 864e5);
                    const r = by.get(l.party_id) ?? { party_id: l.party_id, name: party(l.party_id).name, d0_2: 0, d3_7: 0, d8_plus: 0 };
                    by.set(l.party_id, r);
                    const v = l.debit - l.credit;
                    if (age <= 2)
                        r.d0_2 += v;
                    else if (age <= 7)
                        r.d3_7 += v;
                    else
                        r.d8_plus += v;
                }
                return [...by.values()];
            }
            case "supplier_balances": return supplierBalances();
            case "customer_balances": {
                const ids = [key("AR_CUSTOMERS"), key("CUSTOMER_CREDIT")];
                return S.parties.map((p) => ({ party_id: p.id, name: p.name, owes_us: sum(S.lines.filter((l) => l.party_id === p.id && ids.includes(l.account_id)).map((l) => l.debit - l.credit)) }))
                    .filter((r) => S.lines.some((l) => l.party_id === r.party_id && ids.includes(l.account_id))).sort((a, b) => b.owes_us - a.owes_us);
            }
            case "stock_value": return stockRows();
            case "purchases_daily": {
                const ap = key("AP_SUPPLIERS");
                const by = new Map();
                for (const l of lineRows()) {
                    if (l.account_id !== ap || !["purchase_receipt", "supplier_return"].includes(l.e.source_type))
                        continue;
                    const r = by.get(l.e.entry_date) ?? { day: l.e.entry_date, purchased: 0 };
                    by.set(l.e.entry_date, r);
                    r.purchased += l.credit - l.debit;
                }
                return [...by.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
            }
            case "dropship_to_forward": return S.oLines.map((ol) => {
                const o = S.orders.find((x) => x.id === ol.order_id);
                const v = S.variants.find((x) => x.id === ol.variant_id), p = S.products.find((x) => x.id === v.product_id);
                return { o, ol, v, p };
            }).filter(({ o, ol, v, p }) => o.status === "new" && (ol.fulfillment ?? v.fulfillment ?? p.fulfillment) === "dropship")
                .map(({ o, ol, v, p }) => { const sid = ol.supplier_id ?? v.supplier_id ?? p.default_supplier_id; return { supplier_id: sid, supplier: party(sid)?.name ?? null, order_no: o.order_no, title: p.title, variant: v.title, qty: ol.qty }; })
                .sort((a, b) => String(a.supplier).localeCompare(String(b.supplier), "ar"));
            case "trial_balance": {
                const m = new Map();
                for (const l of S.lines) {
                    const r = m.get(l.account_id) ?? { d: 0, c: 0 };
                    m.set(l.account_id, r);
                    r.d += l.debit;
                    r.c += l.credit;
                }
                return S.accounts.filter((a) => m.has(a.id)).sort((a, b) => a.code.localeCompare(b.code)).map((a) => ({ code: a.code, name_ar: a.name_ar, total_debit: m.get(a.id).d, total_credit: m.get(a.id).c }));
            }
            case "cashboxes": return cashboxList().map((c) => ({ cashbox_id: c.id, name: c.name, kind: c.kind, balance: c.balance }));
        }
        throw nf("unknown report");
    }
    function dashboard() {
        const att = new Map();
        for (const o of S.orders)
            if (["needs_review", "awaiting_payment", "new"].includes(o.status))
                att.set(o.status, (att.get(o.status) ?? 0) + 1);
        return { cashboxes: cashboxList().map((c) => ({ name: c.name, kind: c.kind, balance: c.balance })), carriers: carrierPending(), suppliers: supplierBalances().filter((s) => s.we_owe !== 0),
            month: monthly().slice(0, 3), attention: [...att].map(([status, n]) => ({ status, n })), lowStock: stockRows().filter((r) => r.low) };
    }
    function orderList(url) {
        const st = url.get("status"), q = (url.get("q") ?? "").toLowerCase();
        return [...S.orders].filter((o) => (!st || o.status === st) && (!q || [o.order_no, o.customer_name, o.awb].some((x) => String(x ?? "").toLowerCase().includes(q))))
            .sort((a, b) => (a.ordered_at < b.ordered_at ? 1 : a.ordered_at > b.ordered_at ? -1 : 0)).slice(0, 300)
            .map((o) => ({ id: o.id, order_no: o.order_no, ordered_at: o.ordered_at, status: o.status, payment_method: o.payment_method, province: o.province, delivery_type: o.delivery_type, goods_total: o.goods_total,
            shipping_charged: o.shipping_charged, customer_name: o.customer_name, review_reason: o.review_reason, carrier: S.carriers.find((c) => c.id === o.carrier_id)?.name ?? null, awb: o.awb }));
    }
    /** Mutating route. Returns the handler result; the caller wraps it in the snapshot. */
    function mutate(m, path, b, url) {
        let mt;
        const is = (method, re) => (m === method && (mt = re.exec(path)) !== null);
        if (is("POST", /^\/api\/parties$/)) {
            const kinds = Array.isArray(b.kinds) ? b.kinds : [b.kind];
            if (!String(b.name ?? "").trim())
                throw new LedgerError("الاسم مطلوب");
            const id = nid(S, "parties");
            S.parties.push({ id, name: String(b.name).trim(), kinds, phone: b.phone ?? null, notes: b.notes ?? null, active: true });
            return { id };
        }
        if (is("PUT", /^\/api\/parties\/(\d+)$/)) {
            const p = party(badId(mt[1]));
            if (!p)
                throw nf("party not found");
            for (const k of ["name", "phone", "notes", "active"])
                if (b[k] != null)
                    p[k] = b[k];
            return { ok: true };
        }
        if (is("POST", /^\/api\/cashboxes$/)) {
            if (!String(b.name ?? "").trim() || !["cash", "bank"].includes(b.kind))
                throw new LedgerError("الاسم والنوع مطلوبان");
            const next = Math.max(1020, ...S.accounts.filter((a) => /^10\d\d$/.test(a.code)).map((a) => Number(a.code))) + 1;
            const aid = nid(S, "accounts");
            S.accounts.push({ id: aid, code: String(next), system_key: null, name_ar: String(b.name).trim(), type: "asset", normal_side: "debit", party_kind: null, is_postable: true, active: true });
            const id = nid(S, "cashboxes");
            S.cashboxes.push({ id, name: String(b.name).trim(), kind: b.kind, account_id: aid, active: true });
            return { id, accountId: aid };
        }
        if (is("POST", /^\/api\/journal\/(\d+)\/reverse$/)) {
            const e = S.entries.find((x) => x.id === badId(mt[1]));
            if (!e)
                throw nf("entry not found");
            const lines = S.lines.filter((l) => l.entry_id === e.id).sort((a, c) => a.line_no - c.line_no).map((l) => ({ accountId: l.account_id, partyId: l.party_id, debit: l.debit, credit: l.credit }));
            const r = post(S, buildReversal({ id: e.id, description: e.description, lines }, String(b.date ?? today())));
            if (r.duplicate)
                throw new LedgerError("هذا القيد معكوس من قبل");
            return r;
        }
        if (is("POST", /^\/api\/vouchers$/))
            return S_.createVoucher(S, b);
        if (is("POST", /^\/api\/cash-counts$/))
            return S_.cashCount(S, b);
        if (is("POST", /^\/api\/orders\/import$/)) {
            const r = parseShopifyOrdersCsv(String(b.csv ?? ""));
            if (r.problems.length)
                throw new LedgerError(r.problems.join("، "));
            return { parsed: r.orders.length, ...S_.importOrders(S, r.orders) };
        }
        if (is("POST", /^\/api\/orders\/(\d+)\/(resolve|confirm-transfer|handover|deliver|return|cancel)$/)) {
            const id = badId(mt[1]), act = mt[2];
            return act === "resolve" ? S_.resolveOrder(S, id, b) : act === "confirm-transfer" ? S_.confirmTransfer(S, id, b) : act === "handover" ? S_.handoverOrder(S, id, b)
                : act === "deliver" ? S_.deliverOrder(S, id, b) : act === "return" ? S_.returnOrder(S, id, b) : S_.cancelOrder(S, id, b);
        }
        if (is("PUT", /^\/api\/variants\/(\d+)$/))
            return S_.updateVariant(S, badId(mt[1]), b);
        if (is("POST", /^\/api\/stock\/opening$/))
            return S_.openingStock(S, b);
        if (is("POST", /^\/api\/stock\/counts$/))
            return S_.stockCount(S, b);
        if (is("POST", /^\/api\/purchases$/))
            return S_.createPurchase(S, b);
        if (is("POST", /^\/api\/purchases\/(\d+)\/receive$/))
            return S_.receivePurchase(S, badId(mt[1]), b);
        if (is("POST", /^\/api\/purchases\/(\d+)\/cancel$/))
            return S_.cancelPurchase(S, badId(mt[1]));
        if (is("PUT", /^\/api\/carriers\/(\d+)$/)) {
            const c = S.carriers.find((x) => x.id === badId(mt[1]));
            if (!c)
                throw nf("carrier not found");
            if (b.returnFee != null)
                c.return_fee = Number(b.returnFee);
            if (b.settlementDays != null)
                c.settlement_days = Number(b.settlementDays);
            if (b.supportsOffice != null)
                c.supports_office = !!b.supportsOffice;
            if (b.coverageAll != null)
                c.coverage_all = !!b.coverageAll;
            if (Array.isArray(b.rates)) {
                S.rates = S.rates.filter((r) => r.carrier_id !== c.id);
                for (const r of b.rates)
                    S.rates.push({ carrier_id: c.id, delivery_type: r.deliveryType, region: r.region || null, cost: Number(r.cost) });
            }
            if (Array.isArray(b.coverage)) {
                S.coverage = S.coverage.filter((r) => r.carrier_id !== c.id);
                for (const r of b.coverage)
                    S.coverage.push({ carrier_id: c.id, region: String(r).trim().toLowerCase(), enabled: true });
            }
            return { ok: true };
        }
        if (is("POST", /^\/api\/settlements\/commit$/))
            return S_.commitSettlement(S, b);
        if (is("PUT", /^\/api\/settings\/(\w+)$/)) {
            if (!SETTING_KEYS.has(mt[1]))
                throw nf("unknown setting");
            S.settings[mt[1]] = b.value;
            return { ok: true };
        }
        if (is("PUT", /^\/api\/shipping-map$/)) {
            const rows = [];
            for (const r of b.rows ?? []) {
                if (!["home", "office"].includes(r.deliveryType) || !String(r.titleMatch ?? "").trim())
                    throw new LedgerError("صف خريطة شحن غير صالح");
                rows.push({ title_match: String(r.titleMatch).trim(), carrier_id: S.carriers.find((c) => c.key === r.carrier)?.id ?? null, delivery_type: r.deliveryType });
            }
            S.shipMap = rows;
            return { ok: true };
        }
        if (is("POST", /^\/api\/backup\/restore$/)) {
            const n = typeof b.data === "string" ? JSON.parse(b.data) : b.data;
            if (!n || n.v !== 1 || !Array.isArray(n.entries) || !Array.isArray(n.accounts))
                throw new LedgerError("ملف النسخة الاحتياطية غير صالح");
            S = n;
            return { ok: true, entries: n.entries.length };
        }
        if (is("POST", /^\/api\/backup\/reset$/)) {
            if (b.confirm !== "DELETE-ALL")
                throw new LedgerError("تأكيد مفقود");
            S = seed();
            return { ok: true };
        }
        return undefined;
    }
    function read(m, path, url) {
        let mt;
        const is = (re) => (m === "GET" && (mt = re.exec(path)) !== null);
        if (is(/^\/api\/me$/))
            return { uid: 1, role: "owner" };
        if (is(/^\/api\/dashboard$/))
            return dashboard();
        if (is(/^\/api\/parties$/)) {
            const k = url.get("kind");
            return S.parties.filter((p) => p.active && (!k || p.kinds.includes(k))).sort((a, b) => a.name.localeCompare(b.name, "ar"));
        }
        if (is(/^\/api\/accounts$/))
            return S.accounts.filter((a) => a.active).sort((a, b) => a.code.localeCompare(b.code)).map((a) => ({ id: a.id, code: a.code, system_key: a.system_key, name_ar: a.name_ar, type: a.type, party_kind: a.party_kind, is_postable: a.is_postable }));
        if (is(/^\/api\/cashboxes$/))
            return cashboxList();
        if (is(/^\/api\/statement$/)) {
            const p = url.get("partyId"), a = url.get("accountId");
            if (p)
                return statement((l) => l.party_id === badId(p) && (!a || l.account_id === badId(a)));
            if (a)
                return statement((l) => l.account_id === badId(a));
            throw new LedgerError("partyId أو accountId مطلوب");
        }
        if (is(/^\/api\/journal$/)) {
            const lim = Math.min(Number(url.get("limit") ?? 100), 500);
            const rev = new Set(S.entries.map((e) => e.reverses_entry_id).filter(Boolean));
            return [...S.entries].sort((a, b) => b.id - a.id).slice(0, lim).map((e) => ({ id: e.id, entry_date: e.entry_date, description: e.description, source_type: e.source_type, reverses_entry_id: e.reverses_entry_id,
                reversed: rev.has(e.id), lines: S.lines.filter((l) => l.entry_id === e.id).sort((a, b) => a.line_no - b.line_no).map((l) => ({ account: `${acct(l.account_id).code} ${acct(l.account_id).name_ar}`, party: party(l.party_id)?.name ?? null, debit: l.debit, credit: l.credit })) }));
        }
        if (is(/^\/api\/vouchers$/))
            return [...S.vouchers].sort((a, b) => b.id - a.id).slice(0, 200).map((v) => ({ ...v, cashbox: S.cashboxes.find((c) => c.id === v.cashbox_id)?.name, party: party(v.party_id)?.name ?? null, account: acct(v.account_id)?.name_ar ?? null }));
        if (is(/^\/api\/orders$/))
            return orderList(url);
        if (is(/^\/api\/orders\/(\d+)$/))
            return S_.orderDetail(S, badId(mt[1]));
        if (is(/^\/api\/orders\/(\d+)\/suggest-carrier$/)) {
            const o = S.orders.find((x) => x.id === badId(mt[1]));
            return o?.province && o.delivery_type ? S_.suggestCarrier(S, { province: o.province, deliveryType: o.delivery_type }) : null;
        }
        if (is(/^\/api\/products$/))
            return S_.listProducts(S);
        if (is(/^\/api\/stock\/movements$/)) {
            const v = url.get("variantId");
            return [...S.movements].filter((x) => !v || x.variant_id === Number(v)).sort((a, b) => b.id - a.id).slice(0, 300);
        }
        if (is(/^\/api\/purchases$/))
            return [...S.purchases].sort((a, b) => b.id - a.id).slice(0, 200).map((i) => {
                const ls = S.pLines.filter((l) => l.invoice_id === i.id);
                return { id: i.id, invoice_no: i.invoice_no, invoice_date: i.invoice_date, status: i.status, payment_terms: i.payment_terms, supplier: party(i.supplier_id)?.name, total: sum(ls.map((l) => l.qty_ordered * l.unit_cost)), received_value: sum(ls.map((l) => l.qty_received * l.unit_cost)) };
            });
        if (is(/^\/api\/purchases\/(\d+)$/)) {
            const inv = S.purchases.find((p) => p.id === badId(mt[1]));
            if (!inv)
                throw nf("not found");
            return { invoice: { ...inv, supplier: party(inv.supplier_id)?.name }, lines: S.pLines.filter((l) => l.invoice_id === inv.id).map((l) => { const v = S.variants.find((x) => x.id === l.variant_id); return { ...l, title: S.products.find((p) => p.id === v.product_id).title, variant: v.title }; }) };
        }
        if (is(/^\/api\/carriers$/))
            return S.carriers.filter((c) => c.active).map((c) => ({ ...c, rates: S.rates.filter((r) => r.carrier_id === c.id), coverage: S.coverage.filter((r) => r.carrier_id === c.id).map((r) => r.region) }));
        if (is(/^\/api\/settlements$/))
            return [...S.settlements].sort((a, b) => b.id - a.id).slice(0, 100).map((s) => ({ ...s, carrier: S.carriers.find((c) => c.id === s.carrier_id)?.name }));
        if (is(/^\/api\/reports\/(\w+)$/))
            return report(mt[1]);
        if (is(/^\/api\/settings$/))
            return { settings: Object.fromEntries([...SETTING_KEYS].filter((k) => S.settings[k] !== undefined).map((k) => [k, S.settings[k]])),
                shippingMap: S.shipMap.map((x) => ({ title_match: x.title_match, delivery_type: x.delivery_type, carrier: S.carriers.find((c) => c.id === x.carrier_id)?.key ?? null })) };
        if (is(/^\/api\/users$/))
            return [{ id: 1, username: "owner", full_name: "المالك", role: "owner", active: true }];
        if (is(/^\/api\/backup\/export$/))
            return { data: JSON.stringify(S), at: new Date().toISOString() };
        return undefined;
    }
    let chain = Promise.resolve();
    /** Same contract as fetch-to-the-server: resolves {status, json}. Calls run one at a time. */
    function handle(method, fullPath, body) {
        const run = async () => {
            const u = new URL(fullPath, "http://local");
            const path = u.pathname;
            try {
                let out;
                if (method === "GET")
                    out = read(method, path, u.searchParams);
                else if (method === "POST" && path === "/api/settlements/check")
                    out = S_.previewSettlement(S, body ?? {});
                else {
                    const snap = JSON.stringify(S);
                    try {
                        out = mutate(method, path, body ?? {}, u.searchParams);
                        if (out !== undefined)
                            await storage.save(JSON.stringify(S));
                    }
                    catch (e) {
                        S = JSON.parse(snap);
                        throw e;
                    }
                }
                if (out === undefined)
                    return { status: 404, json: { error: "not found" } };
                return { status: 200, json: JSON.parse(JSON.stringify(out)) };
            }
            catch (e) {
                const status = e?.status ?? (e instanceof LedgerError ? 422 : 500);
                return { status, json: { error: e?.message ?? String(e) } };
            }
        };
        const p = chain.then(run, run);
        chain = p.catch(() => { });
        return p;
    }
    return { handle, state: () => S };
}
