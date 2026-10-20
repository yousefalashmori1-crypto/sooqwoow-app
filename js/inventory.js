import { LedgerError } from "./ledger.js";
const int = (n, what) => {
    if (!Number.isSafeInteger(n) || n <= 0)
        throw new LedgerError(`${what} must be a positive integer`);
};
/** Goods received at a unit cost. Weighted average emerges from value/qty. */
export function receive(s, qty, unitCost) {
    int(qty, "qty");
    if (!Number.isSafeInteger(unitCost) || unitCost < 0)
        throw new LedgerError("unitCost must be a non-negative integer");
    const value = qty * unitCost;
    return { state: { qty: s.qty + qty, value: s.value + value }, value };
}
/** Units leave stock at the current average cost. Selling everything takes exactly the remaining value (no drift). */
export function issue(s, qty) {
    int(qty, "qty");
    if (qty > s.qty)
        throw new LedgerError(`insufficient stock: have ${s.qty}, need ${qty}`);
    const cost = qty === s.qty ? s.value : Math.round((s.value * qty) / s.qty);
    return { state: { qty: s.qty - qty, value: s.value - cost }, cost };
}
/** Customer return of sellable goods: back in at the cost they left with. */
export function returnIn(s, qty, originalCostOfThoseUnits) {
    int(qty, "qty");
    if (!Number.isSafeInteger(originalCostOfThoseUnits) || originalCostOfThoseUnits < 0)
        throw new LedgerError("cost must be a non-negative integer");
    return { qty: s.qty + qty, value: s.value + originalCostOfThoseUnits };
}
/** Cost carried by `retQty` of an original sale line (`origQty` units, `origCost` total). */
export function proportionalCost(origCost, origQty, retQty) {
    int(origQty, "origQty");
    int(retQty, "retQty");
    if (retQty > origQty)
        throw new LedgerError("cannot return more than was sold");
    return retQty === origQty ? origCost : Math.round((origCost * retQty) / origQty);
}
/** Count adjustment. Shortage leaves at average cost; surplus enters at average (or fallbackUnitCost when stock is empty). */
export function adjustTo(s, countedQty, fallbackUnitCost = 0) {
    if (!Number.isSafeInteger(countedQty) || countedQty < 0)
        throw new LedgerError("countedQty must be a non-negative integer");
    const diff = countedQty - s.qty;
    if (diff === 0)
        return { state: s, qtyDelta: 0, valueDelta: 0 };
    if (diff < 0) {
        const r = issue(s, -diff);
        return { state: r.state, qtyDelta: diff, valueDelta: -r.cost };
    }
    const unit = s.qty > 0 ? Math.round(s.value / s.qty) : fallbackUnitCost;
    const r = receive(s, diff, unit);
    return { state: r.state, qtyDelta: diff, valueDelta: r.value };
}
// ---------- Partial receipts ----------
export function remainingToReceive(ordered, received) {
    return Math.max(0, ordered - received);
}
export function assertReceivable(ordered, received, nowReceiving) {
    int(nowReceiving, "nowReceiving");
    if (received + nowReceiving > ordered) {
        throw new LedgerError(`receiving ${nowReceiving} would exceed the ordered quantity (${ordered}, already received ${received})`);
    }
}
// ---------- Entries ----------
/** Goods received from supplier: Dr Inventory, Cr Supplier payable. Only RECEIVED quantity is booked. */
export function buildPurchaseReceiptEntry(a) {
    int(a.amount, "amount");
    return {
        entryDate: a.date, description: a.note ?? "استلام بضاعة", sourceType: "purchase_receipt", sourceId: a.invoiceId ?? null,
        idempotencyKey: a.idempotencyKey ?? null,
        lines: [
            { accountId: a.inventoryAccountId, debit: a.amount },
            { accountId: a.payableAccountId, partyId: a.supplierId, credit: a.amount },
        ],
    };
}
/** Goods returned to supplier: Dr Supplier payable, Cr Inventory. */
export function buildSupplierReturnEntry(a) {
    int(a.amount, "amount");
    return {
        entryDate: a.date, description: a.note ?? "مرتجع مشتريات", sourceType: "supplier_return", idempotencyKey: a.idempotencyKey ?? null,
        lines: [
            { accountId: a.payableAccountId, partyId: a.supplierId, debit: a.amount },
            { accountId: a.inventoryAccountId, credit: a.amount },
        ],
    };
}
/** Stock count difference. Shortage: Dr loss, Cr Inventory. Surplus: Dr Inventory, Cr shrinkage account. */
export function buildStockAdjustmentEntry(a) {
    if (a.valueDelta === 0)
        return null;
    const amt = Math.abs(a.valueDelta);
    return {
        entryDate: a.date, description: a.note ?? (a.valueDelta < 0 ? "عجز جرد المخزون" : "زيادة جرد المخزون"),
        sourceType: "stock_adjustment", idempotencyKey: a.idempotencyKey ?? null,
        lines: a.valueDelta < 0
            ? [{ accountId: a.lossAccountId, debit: amt }, { accountId: a.inventoryAccountId, credit: amt }]
            : [{ accountId: a.inventoryAccountId, debit: amt }, { accountId: a.lossAccountId, credit: amt }],
    };
}
