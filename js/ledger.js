export class LedgerError extends Error {
}
/**
 * Pure validation, mirroring the database rules, so errors surface early with clear messages.
 * (The database enforces the same rules again; this is the first line of defence, not the only one.)
 */
export function validateEntry(draft, accounts, partyKinds) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.entryDate))
        throw new LedgerError("entryDate must be YYYY-MM-DD");
    if (!draft.description.trim())
        throw new LedgerError("description is required");
    if (draft.lines.length < 2)
        throw new LedgerError("an entry needs at least 2 lines");
    let debit = 0;
    let credit = 0;
    draft.lines.forEach((l, i) => {
        const n = i + 1;
        const d = l.debit ?? 0;
        const c = l.credit ?? 0;
        if (!Number.isSafeInteger(d) || !Number.isSafeInteger(c))
            throw new LedgerError(`line ${n}: amounts must be integer baisa`);
        if (d < 0 || c < 0)
            throw new LedgerError(`line ${n}: negative amount`);
        if ((d > 0) === (c > 0))
            throw new LedgerError(`line ${n}: exactly one of debit/credit must be positive`);
        const acc = accounts.get(l.accountId);
        if (!acc)
            throw new LedgerError(`line ${n}: unknown account ${l.accountId}`);
        if (!acc.isPostable || !acc.active)
            throw new LedgerError(`line ${n}: account ${acc.code} is not postable`);
        if (acc.partyKind) {
            if (l.partyId == null)
                throw new LedgerError(`line ${n}: account ${acc.code} requires a ${acc.partyKind}`);
            const kinds = partyKinds.get(l.partyId);
            if (!kinds?.includes(acc.partyKind))
                throw new LedgerError(`line ${n}: party ${l.partyId} is not a ${acc.partyKind}`);
        }
        else if (l.partyId != null) {
            throw new LedgerError(`line ${n}: account ${acc.code} does not take a party`);
        }
        debit += d;
        credit += c;
    });
    if (debit !== credit)
        throw new LedgerError(`unbalanced entry: debit ${debit} <> credit ${credit}`);
}
/** Mirror image of a posted entry: every line flipped. Used for cancellations and corrections. */
export function buildReversal(original, entryDate) {
    return {
        entryDate,
        description: `عكس قيد #${original.id}: ${original.description}`,
        sourceType: "reversal",
        sourceId: original.id,
        reversesEntryId: original.id,
        idempotencyKey: `reversal:${original.id}`,
        lines: original.lines.map((l) => ({
            accountId: l.accountId,
            partyId: l.partyId ?? null,
            debit: l.credit ?? 0,
            credit: l.debit ?? 0,
            memo: l.memo,
        })),
    };
}
/**
 * Post an entry inside the CALLER's transaction (so an invoice, its stock movement and its entry
 * commit together or not at all). Returns the entry id, or the existing id if idempotencyKey was
 * already posted (safe against Shopify webhook retries).
 */
export async function postEntry(db, draft, userId) {
    if (draft.idempotencyKey) {
        const ex = await db.query("SELECT id FROM journal_entries WHERE idempotency_key = $1", [draft.idempotencyKey]);
        if (ex.rows[0])
            return { id: Number(ex.rows[0].id), duplicate: true };
    }
    const ids = [...new Set(draft.lines.map((l) => l.accountId))];
    const accRows = (await db.query("SELECT id, code, is_postable, active, party_kind FROM accounts WHERE id = ANY($1)", [ids])).rows;
    const accounts = new Map(accRows.map((r) => [Number(r.id), {
            id: Number(r.id), code: r.code, isPostable: r.is_postable, active: r.active, partyKind: r.party_kind
        }]));
    const pids = [...new Set(draft.lines.map((l) => l.partyId).filter((x) => x != null))];
    const partyRows = pids.length ? (await db.query("SELECT id, kinds FROM parties WHERE id = ANY($1)", [pids])).rows : [];
    const partyKinds = new Map(partyRows.map((r) => [Number(r.id), r.kinds]));
    validateEntry(draft, accounts, partyKinds);
    const e = await db.query(`INSERT INTO journal_entries (entry_date, description, source_type, source_id, idempotency_key, reverses_entry_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [draft.entryDate, draft.description, draft.sourceType, draft.sourceId ?? null,
        draft.idempotencyKey ?? null, draft.reversesEntryId ?? null, userId]);
    const id = Number(e.rows[0].id);
    let n = 1;
    for (const l of draft.lines) {
        await db.query(`INSERT INTO journal_lines (entry_id, line_no, account_id, party_id, debit, credit, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, n++, l.accountId, l.partyId ?? null, l.debit ?? 0, l.credit ?? 0, l.memo ?? null]);
    }
    return { id, duplicate: false };
}
