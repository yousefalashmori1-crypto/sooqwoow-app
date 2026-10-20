import { LedgerError } from "./ledger.js";
export function extractOrderNo(note) {
    const m = /^\s*#?(\d{3,})/.exec(String(note));
    return m ? m[1] : null;
}
export function classifyRow(r) {
    const s = r.status.trim().toLowerCase();
    if (s === "delivered")
        return r.cod > 0 ? "cod_delivered" : "prepaid_delivered";
    if (s === "return" || s === "returned")
        return "returned";
    return "other";
}
export function reconcile(rows, received, expected) {
    let codNet = 0, prepaidShipping = 0, returnFees = 0;
    const matched = [];
    const differences = [];
    const unknownOrders = [];
    const seen = new Set();
    for (const r of rows) {
        const kind = classifyRow(r);
        if (kind === "cod_delivered")
            codNet += r.cod - r.shippingPrice;
        else if (kind === "prepaid_delivered")
            prepaidShipping += r.shippingPrice;
        else if (kind === "returned")
            returnFees += r.shippingPrice;
        const no = extractOrderNo(r.note);
        if (!expected) {
            matched.push({ row: r, orderNo: no });
            continue;
        }
        const e = no ? expected.get(no) : undefined;
        if (!no || !e) {
            unknownOrders.push(r);
            continue;
        }
        seen.add(no);
        if (kind === "cod_delivered" && e.expectedCod !== r.cod)
            differences.push({ row: r, orderNo: no, reason: `COD ${r.cod} vs expected ${e.expectedCod}` });
        else if (kind === "prepaid_delivered" && e.method === "cod")
            differences.push({ row: r, orderNo: no, reason: "statement shows no COD but order is cash on delivery" });
        else
            matched.push({ row: r, orderNo: no });
    }
    const expectedNet = codNet - prepaidShipping - returnFees;
    const missingFromStatement = expected ? [...expected.values()].filter((e) => !seen.has(e.orderNo)) : [];
    return { codNet, prepaidShipping, returnFees, expectedNet, received, difference: received - expectedNet, matched, differences, unknownOrders, missingFromStatement };
}
/**
 * Money arrives from the carrier.
 *  Dr Bank (received) ; Dr Carrier payable (prepaid shipping they deducted) ; Dr/Cr Settlement differences (accepted only)
 *  Cr Carrier receivable (received + prepaid + accepted).
 * An unresolved difference is NOT written off: it simply stays open in the carrier receivable.
 */
export function buildCarrierSettlementEntry(a) {
    const accepted = a.acceptedDifference ?? 0; // positive = we accept a shortfall (expense), negative = accept an overpayment
    if (a.received < 0 || a.prepaidShipping < 0)
        throw new LedgerError("amounts must be non-negative");
    const lines = [];
    if (a.received > 0)
        lines.push({ accountId: a.bankAccountId, debit: a.received });
    if (a.prepaidShipping > 0)
        lines.push({ accountId: a.payableAccountId, partyId: a.carrierPartyId, debit: a.prepaidShipping });
    if (accepted > 0)
        lines.push({ accountId: a.diffAccountId, debit: accepted });
    if (accepted < 0)
        lines.push({ accountId: a.diffAccountId, credit: -accepted });
    const credit = a.received + a.prepaidShipping + accepted;
    lines.push({ accountId: a.receivableAccountId, partyId: a.carrierPartyId, credit });
    return {
        entryDate: a.date, description: `تسوية ${a.carrierKey}`, sourceType: "carrier_settlement",
        idempotencyKey: a.fileHash ? `settlement:${a.carrierKey}:${a.fileHash}` : null, lines,
    };
}
