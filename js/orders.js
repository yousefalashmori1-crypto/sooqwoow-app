import { LedgerError, buildReversal } from "./ledger.js";
const nonNeg = (n, what) => {
    if (!Number.isSafeInteger(n) || n < 0)
        throw new LedgerError(`${what} must be a non-negative integer (baisa)`);
};
/** Merge lines on the same account/party and drop zeros (keeps entries short and readable). */
export function mergeLines(lines) {
    const m = new Map();
    for (const l of lines) {
        const k = `${l.accountId}:${l.partyId ?? ""}`;
        const cur = m.get(k) ?? { accountId: l.accountId, partyId: l.partyId ?? null, net: 0 };
        cur.net += (l.debit ?? 0) - (l.credit ?? 0);
        m.set(k, cur);
    }
    return [...m.values()].filter((x) => x.net !== 0).map((x) => x.net > 0 ? { accountId: x.accountId, partyId: x.partyId, debit: x.net } : { accountId: x.accountId, partyId: x.partyId, credit: -x.net });
}
/** Net profit of one order, in baisa. */
export function orderProfit(i) {
    const dropshipCost = (i.dropship ?? []).reduce((s, d) => s + d.cost, 0);
    return i.goodsTotal + i.shippingCharged - i.carrierCost - i.stockCogs - dropshipCost - (i.gatewayFee ?? 0);
}
/**
 * Recognition entry for an order (COD: at delivery; gateway/transfer: when paid/confirmed).
 * COD:      carrier collects total, keeps its fee  -> Dr Carrier receivable (total - fee), Dr Shipping expense.
 * Gateway:  Dr Gateway receivable (total - gateway fee), Dr Gateway fees; carrier fee is owed -> Cr Carrier payable.
 * Transfer: Dr Customer receivable (total); carrier fee is owed -> Cr Carrier payable.
 */
export function buildSaleEntry(i, a, idempotencyKey) {
    nonNeg(i.goodsTotal, "goodsTotal");
    nonNeg(i.shippingCharged, "shippingCharged");
    nonNeg(i.carrierCost, "carrierCost");
    nonNeg(i.stockCogs, "stockCogs");
    const total = i.goodsTotal + i.shippingCharged;
    const lines = [];
    if (i.method === "cod") {
        lines.push({ accountId: a.AR_CARRIERS, partyId: i.carrierPartyId, debit: total - i.carrierCost });
        lines.push({ accountId: a.SHIPPING_EXPENSE, debit: i.carrierCost });
    }
    else {
        if (i.method === "gateway") {
            if (i.gatewayPartyId == null)
                throw new LedgerError("gateway orders need gatewayPartyId");
            const fee = i.gatewayFee ?? 0;
            nonNeg(fee, "gatewayFee");
            lines.push({ accountId: a.AR_GATEWAY, partyId: i.gatewayPartyId, debit: total - fee });
            lines.push({ accountId: a.GATEWAY_FEES, debit: fee });
        }
        else {
            if (i.customerPartyId == null)
                throw new LedgerError("transfer orders need customerPartyId");
            lines.push({ accountId: a.AR_CUSTOMERS, partyId: i.customerPartyId, debit: total });
        }
        lines.push({ accountId: a.SHIPPING_EXPENSE, debit: i.carrierCost });
        lines.push({ accountId: a.AP_CARRIERS, partyId: i.carrierPartyId, credit: i.carrierCost });
    }
    lines.push({ accountId: a.SALES, credit: i.goodsTotal });
    lines.push({ accountId: a.SHIPPING_REVENUE, credit: i.shippingCharged });
    lines.push({ accountId: a.COGS, debit: i.stockCogs });
    lines.push({ accountId: a.INVENTORY, credit: i.stockCogs });
    for (const d of i.dropship ?? []) {
        nonNeg(d.cost, "dropship cost");
        lines.push({ accountId: a.COGS, debit: d.cost });
        lines.push({ accountId: a.AP_SUPPLIERS, partyId: d.supplierId, credit: d.cost });
    }
    return {
        entryDate: i.date, description: `طلب ${i.orderNo}`, sourceType: "order_sale", sourceId: i.orderId,
        idempotencyKey: idempotencyKey ?? `order:${i.orderId}:sale`, lines: mergeLines(lines),
    };
}
/** Carrier return fee (rejected before delivery, or returned after): Dr Return fees, Cr Carrier receivable. */
export function buildReturnFeeEntry(a, s) {
    nonNeg(a.fee, "fee");
    if (a.fee === 0)
        return null;
    return {
        entryDate: a.date, description: `رسم رجوع طلب ${a.orderNo}`, sourceType: "order_return_fee", sourceId: a.orderId,
        idempotencyKey: `order:${a.orderId}:return_fee`,
        lines: [{ accountId: s.RETURN_FEES, debit: a.fee }, { accountId: s.AR_CARRIERS, partyId: a.carrierPartyId, credit: a.fee }],
    };
}
/** Whole order comes back after a sale was recognized: mirror the sale (goods return to stock at original cost). */
export function buildFullReturnEntries(a, s) {
    const out = [];
    const rev = buildReversal({ id: a.saleEntryId, description: `طلب ${a.orderNo}`, lines: a.saleLines }, a.date);
    rev.sourceType = "order_return";
    rev.sourceId = a.orderId;
    rev.idempotencyKey = `order:${a.orderId}:return`;
    out.push(rev);
    const fee = buildReturnFeeEntry({ orderId: a.orderId, orderNo: a.orderNo, date: a.date, fee: a.fee, carrierPartyId: a.carrierPartyId }, s);
    if (fee)
        out.push(fee);
    if (a.damagedCost && a.damagedCost > 0) {
        out.push({
            entryDate: a.date, description: `بضاعة تالفة - طلب ${a.orderNo}`, sourceType: "order_return_damage", sourceId: a.orderId,
            idempotencyKey: `order:${a.orderId}:damage`,
            lines: [{ accountId: s.INV_DAMAGED, debit: a.damagedCost }, { accountId: s.INVENTORY, credit: a.damagedCost }],
        });
    }
    return out;
}
/** Part of a delivered order comes back. The refund reduces what the carrier owes us, or goes out of cash, or becomes customer credit. */
export function buildPartialReturnEntry(a, s) {
    nonNeg(a.goodsAmount, "goodsAmount");
    nonNeg(a.costBack, "costBack");
    const lines = [{ accountId: s.SALES_RETURNS, debit: a.goodsAmount }];
    if (a.refundTo === "carrier_receivable") {
        if (a.carrierPartyId == null)
            throw new LedgerError("carrierPartyId required");
        lines.push({ accountId: s.AR_CARRIERS, partyId: a.carrierPartyId, credit: a.goodsAmount });
    }
    else {
        lines.push({ accountId: a.cashAccountId ?? s.CASH_MAIN, credit: a.goodsAmount });
    }
    lines.push({ accountId: s.INVENTORY, debit: a.costBack }, { accountId: s.COGS, credit: a.costBack });
    return {
        entryDate: a.date, description: `مرتجع جزئي - طلب ${a.orderNo}`, sourceType: "order_partial_return", sourceId: a.orderId,
        idempotencyKey: `order:${a.orderId}:partial_return:${a.seq}`, lines: mergeLines(lines),
    };
}
const norm = (s) => s.toLowerCase().normalize("NFKD").replace(/[\u064B-\u065F\u0300-\u036f]/g, "").replace(/[^a-z\u0600-\u06ff0-9]+/g, " ").trim();
const MUSCAT = ["muscat", "masqat", "مسقط", "muttrah", "mutrah", "مطرح", "bawshar", "bowsher", "بوشر", "seeb", "al seeb", "السيب", "amerat", "al amerat", "al amarat", "العامرات", "qurayyat", "quriyat", "قريات"];
export function isMuscat(region) {
    const n = norm(region);
    return MUSCAT.some((m) => n === norm(m));
}
export const normRegion = norm;
/** Candidates covering the region and delivery type, fastest settlement first, then cheapest. */
export function chooseCarrier(a) {
    const r = norm(a.region);
    const cands = a.carriers
        .filter((c) => (c.coverage === "all" || c.coverage.map(norm).includes(r) || (isMuscat(r) && c.coverage.map(norm).some(isMuscat))))
        .filter((c) => a.deliveryType === "home" || (c.supportsOffice && c.officeCost != null))
        .map((c) => ({
        carrier: c,
        cost: a.deliveryType === "office" ? c.officeCost : (c.regionCost?.[r] ?? c.homeCost),
    }))
        .sort((x, y) => x.carrier.settlementDays - y.carrier.settlementDays || x.cost - y.cost);
    if (!cands.length)
        return null;
    return { carrier: cands[0].carrier, cost: cands[0].cost, alternatives: cands.slice(1) };
}
/** Flags for the "needs review" screen. Free shipping at >= threshold (after discount) inside Oman. */
export function checkShipping(a) {
    const issues = [];
    if (a.countryCode.toUpperCase() !== "OM") {
        issues.push("outside_oman");
        return issues;
    }
    if (a.totalAfterDiscount >= a.threshold && a.shippingCharged > 0)
        issues.push("shipping_charged_above_free_threshold");
    if (a.totalAfterDiscount < a.threshold && a.shippingCharged === 0)
        issues.push("free_shipping_below_threshold");
    return issues;
}
