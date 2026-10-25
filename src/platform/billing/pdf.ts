/**
 * Minimal, dependency-free PDF 1.4 writer for invoices: A4 pages, the standard Helvetica / Helvetica-Bold fonts
 * (WinAnsiEncoding, so text stays extractable and searchable), text, lines and filled rectangles.
 * Not a general PDF library — just enough for tabular business documents.
 */

// Advance widths (1/1000 em) for ASCII 32..126 — Adobe Core 14 AFM metrics.
const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELVETICA_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

/** Map text to WinAnsi bytes; characters outside it are transliterated or replaced. */
const WIN_ANSI: Record<string, number> = { "–": 0x96, "—": 0x97, "•": 0x95, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "…": 0x85, "×": 0xd7, "·": 0xb7, "é": 0xe9 };
export function toWinAnsi(text: string) {
  const bytes: number[] = [];
  for (const char of String(text ?? "").replace(/₹\s?/g, "Rs. ")) {
    const code = char.codePointAt(0)!;
    if (code >= 32 && code <= 126) bytes.push(code);
    else if (WIN_ANSI[char]) bytes.push(WIN_ANSI[char]);
    else if (char === "\t" || char === "\n" || char === "\r") bytes.push(32);
    else bytes.push(63); // "?"
  }
  return bytes;
}
const widthOf = (code: number, bold: boolean) => {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  if (code >= 32 && code <= 126) return table[code - 32];
  if (code === 0x96) return 556; if (code === 0x97) return 1000; if (code === 0xd7) return 584; if (code === 0x95) return 350; if (code === 0xb7) return 278;
  return 556;
};
export function textWidth(text: string, size: number, bold = false) {
  return (toWinAnsi(text).reduce((sum, code) => sum + widthOf(code, bold), 0) * size) / 1000;
}
const pdfString = (text: string) =>
  "(" + toWinAnsi(text).map((code) => (code === 40 || code === 41 || code === 92 ? `\\${String.fromCharCode(code)}` : code > 126 ? `\\${code.toString(8).padStart(3, "0")}` : String.fromCharCode(code))).join("") + ")";

export type TextOptions = { size?: number; bold?: boolean; color?: [number, number, number]; align?: "left" | "right" | "center" };
const num = (value: number) => (Math.round(value * 100) / 100).toString();

export class PdfDocument {
  readonly width = 595.28;
  readonly height = 841.89;
  private pages: string[][] = [];
  private current: string[] = [];
  constructor(private readonly info: { title: string; author?: string }) { this.addPage(); }

  addPage() { this.current = []; this.pages.push(this.current); }
  get pageCount() { return this.pages.length; }

  /** Draws text with its baseline at (x, y) measured from the TOP-left of the page. */
  text(value: string, x: number, y: number, options: TextOptions = {}) {
    const size = options.size ?? 9;
    const width = textWidth(value, size, options.bold);
    const left = options.align === "right" ? x - width : options.align === "center" ? x - width / 2 : x;
    const [r, g, b] = options.color ?? [0.09, 0.2, 0.24];
    this.current.push(`BT ${num(r)} ${num(g)} ${num(b)} rg /${options.bold ? "F2" : "F1"} ${num(size)} Tf ${num(left)} ${num(this.height - y)} Td ${pdfString(value)} Tj ET`);
    return width;
  }
  /** Wraps text to `maxWidth`, returns the lines (call text() for each) — used for addresses and long descriptions. */
  wrap(value: string, maxWidth: number, size = 9, bold = false) {
    const out: string[] = [];
    for (const paragraph of String(value ?? "").split(/\n/)) {
      let line = "";
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (textWidth(next, size, bold) <= maxWidth || !line) line = next;
        else { out.push(line); line = word; }
      }
      out.push(line);
    }
    return out;
  }
  line(x1: number, y1: number, x2: number, y2: number, width = 0.5, color: [number, number, number] = [0.85, 0.84, 0.8]) {
    this.current.push(`${num(color[0])} ${num(color[1])} ${num(color[2])} RG ${num(width)} w ${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S`);
  }
  rect(x: number, y: number, w: number, h: number, fill: [number, number, number]) {
    this.current.push(`${num(fill[0])} ${num(fill[1])} ${num(fill[2])} rg ${num(x)} ${num(this.height - y - h)} ${num(w)} ${num(h)} re f`);
  }

  toBuffer() {
    const objects: string[] = [];
    const add = (body: string) => { objects.push(body); return objects.length; };
    const catalog = add(""); // placeholder, filled below
    const pagesId = add("");
    const font1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const font2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const pageIds: number[] = [];
    for (const commands of this.pages) {
      const stream = commands.join("\n");
      const contents = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> /Contents ${contents} 0 R >>`));
    }
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
    const infoId = add(`<< /Title ${pdfString(this.info.title)} /Author ${pdfString(this.info.author || "Northstar")} /Producer (Northstar billing) >>`);

    let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
    const offsets: number[] = [];
    objects.forEach((body, index) => {
      offsets.push(Buffer.byteLength(out, "latin1"));
      out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, "latin1");
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  }
}
