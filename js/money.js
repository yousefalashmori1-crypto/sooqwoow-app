/** "12.5" -> 12500. Strict: at most 3 decimals, no floats involved. */
export function parseOmr(input) {
    const m = /^(-)?(\d+)(?:\.(\d{1,3}))?$/.exec(input.trim());
    if (!m)
        throw new Error(`invalid OMR amount: "${input}"`);
    const [, neg, whole, frac = ""] = m;
    const value = Number(whole) * 1000 + Number(frac.padEnd(3, "0"));
    if (!Number.isSafeInteger(value))
        throw new Error(`amount too large: "${input}"`);
    return neg ? -value : value;
}
/** 10400 -> "10.400" */
export function formatOmr(baisa) {
    if (!Number.isInteger(baisa))
        throw new Error("baisa must be an integer");
    const sign = baisa < 0 ? "-" : "";
    const abs = Math.abs(baisa);
    return `${sign}${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, "0")}`;
}
