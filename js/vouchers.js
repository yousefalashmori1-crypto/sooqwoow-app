import { LedgerError, postEntry } from "./ledger.js";
function positive(amount) {
    if (!Number.isSafeInteger(amount) || amount <= 0)
        throw new LedgerError("amount must be a positive integer (baisa)");
}
/** Money comes in. Customer / carrier / gateway pays us: Dr cashbox, Cr their receivable. */
export function buildReceipt(a) {
    positive(a.amount);
    return {
        entryDate: a.date, description: a.note ?? "سند قبض", sourceType: "receipt", idempotencyKey: a.idempotencyKey ?? null,
        lines: [
            { accountId: a.cashboxAccountId, debit: a.amount },
            { accountId: a.receivableAccountId, partyId: a.partyId, credit: a.amount },
        ],
    };
}
/** Money goes out to a supplier / carrier we owe: Dr their payable, Cr cashbox. */
export function buildPayment(a) {
    positive(a.amount);
    return {
        entryDate: a.date, description: a.note ?? "سند صرف", sourceType: "payment", idempotencyKey: a.idempotencyKey ?? null,
        lines: [
            { accountId: a.payableAccountId, partyId: a.partyId, debit: a.amount },
            { accountId: a.cashboxAccountId, credit: a.amount },
        ],
    };
}
/** Direct expense paid from a box: Dr expense, Cr cashbox. */
export function buildExpense(a) {
    positive(a.amount);
    return {
        entryDate: a.date, description: a.note ?? "مصروف", sourceType: "expense", idempotencyKey: a.idempotencyKey ?? null,
        lines: [
            { accountId: a.expenseAccountId, debit: a.amount },
            { accountId: a.cashboxAccountId, credit: a.amount },
        ],
    };
}
/** Between two boxes: Dr destination, Cr source. */
export function buildTransfer(a) {
    positive(a.amount);
    if (a.fromAccountId === a.toAccountId)
        throw new LedgerError("cannot transfer to the same cashbox");
    return {
        entryDate: a.date, description: a.note ?? "تحويل بين الصناديق", sourceType: "transfer", idempotencyKey: a.idempotencyKey ?? null,
        lines: [
            { accountId: a.toAccountId, debit: a.amount },
            { accountId: a.fromAccountId, credit: a.amount },
        ],
    };
}
/**
 * Count vs book. Surplus: Dr box, Cr settlement differences. Shortage: Dr settlement differences, Cr box.
 * Returns null when counted equals book (nothing to post).
 */
export function buildCashCount(a) {
    if (!Number.isSafeInteger(a.counted) || a.counted < 0)
        throw new LedgerError("counted amount must be a non-negative integer (baisa)");
    const difference = a.counted - a.bookBalance;
    if (difference === 0)
        return { difference, entry: null };
    const amt = Math.abs(difference);
    return {
        difference,
        entry: {
            entryDate: a.date,
            description: a.note ?? (difference > 0 ? "زيادة جرد الصندوق" : "عجز جرد الصندوق"),
            sourceType: "cash_count", idempotencyKey: a.idempotencyKey ?? null,
            lines: difference > 0
                ? [{ accountId: a.cashboxAccountId, debit: amt }, { accountId: a.diffAccountId, credit: amt }]
                : [{ accountId: a.diffAccountId, debit: amt }, { accountId: a.cashboxAccountId, credit: amt }],
        },
    };
}
/** Cashboxes must not go negative unless explicitly allowed. */
export function assertSufficientFunds(balance, outgoing, allowOverdraft = false) {
    if (!allowOverdraft && balance - outgoing < 0) {
        throw new LedgerError(`insufficient funds: balance ${balance}, needed ${outgoing} (baisa)`);
    }
}
/** Current book balance of a cashbox account (debit - credit), derived from the journal. */
export async function cashboxBalance(db, accountId) {
    const r = await db.query("SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) AS bal FROM journal_lines WHERE account_id = $1", [accountId]);
    return Number(r.rows[0].bal);
}
/** Post a cash count inside the caller's transaction and record it. */
export async function recordCashCount(db, a) {
    const book = await cashboxBalance(db, a.cashboxAccountId);
    const { difference, entry } = buildCashCount({
        date: a.date, cashboxAccountId: a.cashboxAccountId, diffAccountId: a.diffAccountId,
        bookBalance: book, counted: a.counted, note: a.note,
    });
    const entryId = entry ? (await postEntry(db, entry, a.userId)).id : null;
    await db.query(`INSERT INTO cash_counts (cashbox_id, counted_on, book_balance, counted, entry_id, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`, [a.cashboxId, a.date, book, a.counted, entryId, a.note ?? null, a.userId]);
    return { book, difference, entryId };
}
