// In-browser data model. All money is integer baisa. The journal is append-only: there is no code path that edits or deletes it.
import { validateEntry, LedgerError } from "../ledger.js";
export const DEFAULT_PAY = { "cash on delivery": "cod", cod: "cod", "الدفع عند": "cod", manual: "transfer", "bank transfer": "transfer", "تحويل": "transfer", "amwal": "gateway" };
export const nid = (S, t) => (S.seq[t] = (S.seq[t] ?? 0) + 1);
const ACCOUNTS = [
    ["1010", "CASH_MAIN", "الصندوق الرئيسي", "asset", "debit", null], ["1020", "BANK_MAIN", "الحساب البنكي", "asset", "debit", null],
    ["1100", "AR_CUSTOMERS", "ذمم العملاء", "asset", "debit", "customer"], ["1110", "AR_CARRIERS", "مستحقات شركات الشحن", "asset", "debit", "carrier"],
    ["1120", "AR_GATEWAY", "مستحقات بوابة الدفع", "asset", "debit", "gateway"], ["1200", "INVENTORY", "المخزون", "asset", "debit", null],
    ["2100", "AP_SUPPLIERS", "ذمم الموردين", "liability", "credit", "supplier"], ["2200", "CUSTOMER_CREDIT", "أرصدة العملاء الدائنة", "liability", "credit", "customer"],
    ["2300", "AP_CARRIERS", "مستحقات لشركات الشحن", "liability", "credit", "carrier"],
    ["3100", "CAPITAL", "رأس المال", "equity", "credit", null], ["3200", "RETAINED", "الأرباح المحتجزة", "equity", "credit", null], ["3300", "DRAWINGS", "مسحوبات المالك", "equity", "debit", null],
    ["4100", "SALES", "المبيعات", "revenue", "credit", null], ["4110", "SALES_RETURNS", "مرتجعات المبيعات", "revenue", "debit", null], ["4200", "SHIPPING_REVENUE", "إيراد الشحن", "revenue", "credit", null],
    ["5100", "COGS", "تكلفة المبيعات", "expense", "debit", null], ["5200", "INV_SHRINKAGE", "فرق وفقدان مخزون", "expense", "debit", null], ["5210", "INV_DAMAGED", "خسارة بضاعة تالفة", "expense", "debit", null],
    ["6100", "SHIPPING_EXPENSE", "مصروف الشحن", "expense", "debit", null], ["6110", "RETURN_FEES", "رسوم رجوع الشحنات", "expense", "debit", null], ["6120", "GATEWAY_FEES", "رسوم بوابة الدفع", "expense", "debit", null],
    ["6200", "GENERAL_EXPENSE", "مصروفات عامة", "expense", "debit", null], ["6900", "SETTLEMENT_DIFF", "فروق تسوية", "expense", "debit", null],
];
/** Fresh books with the chart of accounts, the two carriers and the default rates. */
export function seed() {
    const S = {
        v: 1, seq: {}, settings: { free_shipping_threshold_baisa: 25000, payment_map: DEFAULT_PAY },
        parties: [], accounts: [], cashboxes: [], entries: [], lines: [], keyIndex: {}, carriers: [], rates: [], coverage: [], shipMap: [],
        products: [], variants: [], stock: {}, movements: [], purchases: [], pLines: [], receipts: [], counts: [], orders: [], oLines: [],
        settlements: [], sLines: [], vouchers: [], cashCounts: [], audit: [],
    };
    for (const [code, key, name, type, side, pk] of ACCOUNTS)
        S.accounts.push({ id: nid(S, "accounts"), code, system_key: key, name_ar: name, type, normal_side: side, party_kind: pk, is_postable: true, active: true });
    const acc = (k) => S.accounts.find((a) => a.system_key === k).id;
    S.cashboxes.push({ id: nid(S, "cashboxes"), name: "الصندوق الرئيسي", kind: "cash", account_id: acc("CASH_MAIN"), active: true }, { id: nid(S, "cashboxes"), name: "الحساب البنكي", kind: "bank", account_id: acc("BANK_MAIN"), active: true });
    const party = (name, kind) => { const id = nid(S, "parties"); S.parties.push({ id, name, kinds: [kind], phone: null, notes: null, active: true }); return id; };
    const dal = party("دليلي", "carrier"), jun = party("الجنيد", "carrier");
    party("بوابة الدفع", "gateway");
    const cDal = nid(S, "carriers"), cJun = nid(S, "carriers");
    S.carriers.push({ id: cDal, key: "dalili", party_id: dal, name: "دليلي", supports_office: true, return_fee: 500, settlement_days: 7, coverage_all: true, active: true }, { id: cJun, key: "junaid", party_id: jun, name: "الجنيد", supports_office: false, return_fee: 0, settlement_days: 1, coverage_all: false, active: true });
    S.rates.push({ carrier_id: cDal, delivery_type: "home", region: null, cost: 1600 }, { carrier_id: cDal, delivery_type: "office", region: null, cost: 1000 }, { carrier_id: cJun, delivery_type: "home", region: null, cost: 2000 });
    for (const r of ["muscat", "muttrah", "bawshar", "seeb", "amerat", "qurayyat"])
        S.coverage.push({ carrier_id: cJun, region: r, enabled: true });
    S.shipMap.push({ title_match: "مكتب", carrier_id: cDal, delivery_type: "office" }, { title_match: "منزل", carrier_id: null, delivery_type: "home" }, { title_match: "شحن مجاني", carrier_id: null, delivery_type: "home" });
    return S;
}
export const sysId = (S, key) => {
    const a = S.accounts.find((x) => x.system_key === key);
    if (!a)
        throw new LedgerError(`missing system account ${key}`);
    return a.id;
};
export function sys(S, extra = []) {
    const keys = ["AR_CUSTOMERS", "AR_CARRIERS", "AR_GATEWAY", "AP_CARRIERS", "AP_SUPPLIERS", "SALES", "SALES_RETURNS", "SHIPPING_REVENUE", "SHIPPING_EXPENSE",
        "COGS", "INVENTORY", "GATEWAY_FEES", "RETURN_FEES", "INV_DAMAGED", "CASH_MAIN", ...extra];
    return Object.fromEntries(keys.map((k) => [k, sysId(S, k)]));
}
/** Post an entry (all-or-nothing together with the rest of the transaction). Same rules the SQL triggers enforced. */
export function post(S, d, createdBy = "owner") {
    if (d.idempotencyKey && S.keyIndex[d.idempotencyKey])
        return { id: S.keyIndex[d.idempotencyKey], duplicate: true };
    if (d.reversesEntryId && S.entries.some((e) => e.reverses_entry_id === d.reversesEntryId))
        throw new LedgerError("هذا القيد معكوس من قبل");
    const accs = new Map(S.accounts.map((a) => [a.id, { id: a.id, code: a.code, isPostable: a.is_postable, active: a.active, partyKind: a.party_kind }]));
    const pk = new Map(S.parties.map((p) => [p.id, p.kinds]));
    validateEntry(d, accs, pk);
    const closed = S.settings.closed_through;
    if (closed && d.entryDate <= closed)
        throw new LedgerError(`cannot post on ${d.entryDate}: period is closed`);
    const id = nid(S, "entries");
    S.entries.push({ id, entry_date: d.entryDate, description: d.description, source_type: d.sourceType, source_id: d.sourceId ?? null,
        idempotency_key: d.idempotencyKey ?? null, reverses_entry_id: d.reversesEntryId ?? null, created_by: createdBy, created_at: new Date().toISOString() });
    let n = 1;
    for (const l of d.lines)
        S.lines.push({ entry_id: id, line_no: n++, account_id: l.accountId, party_id: l.partyId ?? null, debit: l.debit ?? 0, credit: l.credit ?? 0, memo: l.memo ?? null });
    if (d.idempotencyKey)
        S.keyIndex[d.idempotencyKey] = id;
    return { id, duplicate: false };
}
/** debit - credit of an account (optionally one party). */
export function net(S, accountId, partyId) {
    let n = 0;
    for (const l of S.lines)
        if (l.account_id === accountId && (partyId == null || l.party_id === partyId))
            n += l.debit - l.credit;
    return n;
}
/** Balance on the account's normal side. */
export function balance(S, accountKeyOrId) {
    const a = typeof accountKeyOrId === "number" ? S.accounts.find((x) => x.id === accountKeyOrId) : S.accounts.find((x) => x.system_key === accountKeyOrId);
    const n = net(S, a.id);
    return a.normal_side === "debit" ? n : -n;
}
export const audit = (S, action, entity, id, details = {}) => S.audit.push({ id: nid(S, "audit"), action, entity, entity_id: id, details, at: new Date().toISOString() });
export const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Muscat" }).format(new Date());
