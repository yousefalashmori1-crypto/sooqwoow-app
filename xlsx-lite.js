// Tiny .xlsx reader (no dependencies): unzip with DecompressionStream, read shared strings and sheet cells.
// Works in modern browsers and Node 18+. Returns { sheets: [{ name, rows: string[][] }] }.
const td = new TextDecoder();

async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const out = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("ليس ملف xlsx صالحًا");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("ملف مضغوط تالف");
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nl));
    const lnl = dv.getUint16(off + 26, true), lel = dv.getUint16(off + 28, true);
    const start = off + 30 + lnl + lel;
    files[name] = { method, data: u8.subarray(start, start + csize) };
    p += 46 + nl + el + cl;
  }
  return files;
}
const readText = async (f) => td.decode(f.method === 0 ? f.data : await inflateRaw(f.data));

const unesc = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
  if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e.toLowerCase()];
});
const textOf = (xml) => [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unesc(m[1])).join("");
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/[0-9]/g, "")) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const attr = (a, k) => { const m = new RegExp(`\\b${k}="([^"]*)"`).exec(a); return m ? unesc(m[1]) : null; };

export async function readXlsx(buf) {
  const files = await unzip(buf);
  const get = async (n) => (files[n] ? readText(files[n]) : null);
  const wb = await get("xl/workbook.xml"); if (!wb) throw new Error("ملف xlsx بلا مصنّف");
  const rels = (await get("xl/_rels/workbook.xml.rels")) ?? "";
  const relTarget = {};
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) relTarget[attr(m[1], "Id")] = attr(m[1], "Target");
  const sstXml = await get("xl/sharedStrings.xml");
  const sst = sstXml ? [...sstXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attr(m[1], "name"), rid = attr(m[1], "r:id");
    let target = relTarget[rid] ?? "";
    target = target.startsWith("/") ? target.slice(1) : "xl/" + target;
    const xml = await get(target); if (!xml) continue;
    const rows = [];
    for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(cm[1], "r"), t = attr(cm[1], "t"), body = cm[2] ?? "";
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        let val = "";
        if (t === "s") val = sst[Number(v?.[1])] ?? "";
        else if (t === "inlineStr") val = textOf(body);
        else if (v) val = unesc(v[1]);
        if (ref) row[colIndex(ref)] = val;
      }
      rows.push(Array.from(row, (x) => x ?? ""));
    }
    sheets.push({ name, rows });
  }
  return { sheets };
}

export async function sha256Hex(buf) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** "35.600" / "35,600 OMR" -> 35600 baisa. Returns null when it is not an amount. */
export function toBaisa(x) {
  let t = String(x ?? "").replace(/[^\d.,\-]/g, "");
  if (/^-?\d+,\d{1,3}$/.test(t)) t = t.replace(",", ".");          // "35,600" = 35.600 (Omani amounts use 3 decimals)
  const s = t.replace(/,/g, "");
  if (!s || s === "-" || s === ".") return null;
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s); if (!m) return null;
  const v = Number(m[2]) * 1000 + Number((m[3] ?? "").padEnd(3, "0").slice(0, 3));
  return m[1] ? -v : v;
}

const CANDIDATES = {
  note: ["note", "notes", "ملاحظ", "reference", "order", "الطلب", "customer ref"],
  barcode: ["barcode", "awb", "tracking", "باركود", "رقم الشحنة", "waybill", "shipment"],
  status: ["status", "الحالة", "حالة"],
  cod: ["cod", "collect", "amount", "المبلغ", "تحصيل", "cash"],
  shippingPrice: ["shipping", "delivery fee", "fee", "charge", "سعر الشحن", "التوصيل", "رسوم"],
  wilaya: ["wilaya", "city", "state", "region", "الولاية", "المدينة", "destination"],
};
/** Guess which column is which from the header row. Returns { field: columnIndex } for the fields it found. */
export function guessColumns(header) {
  const out = {}; const used = new Set();
  for (const [field, words] of Object.entries(CANDIDATES)) {
    const i = header.findIndex((h, idx) => !used.has(idx) && words.some((w) => String(h).toLowerCase().includes(w)));
    if (i >= 0) { out[field] = i; used.add(i); }
  }
  return out;
}
