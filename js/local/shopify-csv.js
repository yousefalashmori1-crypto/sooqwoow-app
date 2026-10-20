/** RFC-4180 CSV parser (quotes, doubled quotes, newlines inside quotes, BOM). */
export function parseCsv(text) {
    const rows = [];
    let row = [];
    let cur = "";
    let q = false;
    const t = text.replace(/^﻿/, "");
    for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (q) {
            if (c === '"') {
                if (t[i + 1] === '"') {
                    cur += '"';
                    i++;
                }
                else
                    q = false;
            }
            else
                cur += c;
        }
        else if (c === '"')
            q = true;
        else if (c === ",") {
            row.push(cur);
            cur = "";
        }
        else if (c === "\n" || c === "\r") {
            if (c === "\r" && t[i + 1] === "\n")
                i++;
            row.push(cur);
            cur = "";
            if (row.some((x) => x !== ""))
                rows.push(row);
            row = [];
        }
        else
            cur += c;
    }
    row.push(cur);
    if (row.some((x) => x !== ""))
        rows.push(row);
    return rows;
}
/** "10.5" / "10.500" / "1,234.50" / "OMR 3" -> baisa (null when not an amount). */
export function toBaisa(x) {
    const s = String(x ?? "").replace(/[^\d.\-]/g, "");
    if (!s || s === "-" || s === ".")
        return null;
    const m = /^(-)?(\d*)(?:\.(\d+))?$/.exec(s);
    if (!m)
        return null;
    const v = Number(m[2] || "0") * 1000 + Number((m[3] ?? "").padEnd(3, "0").slice(0, 3));
    return m[1] ? -v : v;
}
const COUNTRY = { oman: "OM", "سلطنة عمان": "OM", عمان: "OM", "united arab emirates": "AE", "saudi arabia": "SA", kuwait: "KW", qatar: "QA", bahrain: "BH" };
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, " ").trim();
export function parseShopifyOrdersCsv(text) {
    const rows = parseCsv(text);
    if (rows.length < 2)
        return { orders: [], problems: ["الملف فارغ"] };
    const hdr = rows[0].map((h) => norm(h));
    const col = (...names) => { for (const n of names) {
        const i = hdr.indexOf(norm(n));
        if (i >= 0)
            return i;
    } return -1; };
    const C = {
        name: col("Name"), id: col("Id"), created: col("Created at"), fin: col("Financial Status"), cancelled: col("Cancelled at"),
        qty: col("Lineitem quantity"), item: col("Lineitem name"), price: col("Lineitem price"), sku: col("Lineitem sku"),
        disc: col("Discount Amount"), ship: col("Shipping"), pay: col("Payment Method", "Payment Gateway"), method: col("Shipping Method"),
        prov: col("Shipping Province Name", "Shipping Province", "Shipping City"), cc: col("Shipping Country Code", "Shipping Country"),
        sname: col("Shipping Name", "Billing Name"), phone: col("Shipping Phone", "Phone", "Billing Phone"),
    };
    const problems = [];
    for (const [k, v] of Object.entries(C))
        if (v < 0 && ["name", "qty", "item", "price"].includes(k))
            problems.push(`عمود مفقود: ${k}`);
    if (problems.length)
        return { orders: [], problems };
    const get = (r, i) => (i >= 0 ? (r[i] ?? "").trim() : "");
    const byNo = new Map();
    for (const r of rows.slice(1)) {
        const no = get(r, C.name).replace(/^#/, "");
        if (!no)
            continue;
        let o = byNo.get(no);
        if (!o) {
            const cc = get(r, C.cc);
            o = {
                orderNo: no, shopifyOrderId: get(r, C.id) || null, orderedAt: get(r, C.created) || new Date().toISOString(),
                goodsTotal: 0, discount: toBaisa(get(r, C.disc)) ?? 0, shippingCharged: toBaisa(get(r, C.ship)) ?? 0,
                shippingTitle: get(r, C.method) || null, province: get(r, C.prov), countryCode: cc.length === 2 ? cc.toUpperCase() : (COUNTRY[cc.toLowerCase()] ?? cc),
                financialStatus: get(r, C.fin), gatewayNames: get(r, C.pay) ? get(r, C.pay).split(/[,+]/).map((x) => x.trim()) : [],
                customerName: get(r, C.sname), phone: get(r, C.phone) || null, cancelled: !!get(r, C.cancelled), lines: [],
            };
            byNo.set(no, o);
        }
        const qty = Number(get(r, C.qty));
        const price = toBaisa(get(r, C.price));
        if (qty > 0 && price != null) {
            const full = get(r, C.item);
            const m = /^(.*?)\s+-\s+([^-]+)$/.exec(full);
            o.lines.push({ sku: get(r, C.sku) || null, title: m ? m[1] : full, variantTitle: m ? m[2].trim() : null, qty, unitPrice: price });
        }
    }
    const orders = [...byNo.values()];
    for (const o of orders)
        o.goodsTotal = o.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0) - o.discount;
    return { orders, problems };
}
