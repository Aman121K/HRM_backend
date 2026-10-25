/**
 * Minimal, dependency-free PDF 1.4 writer for statutory documents (A4, Helvetica / Helvetica-Bold, WinAnsi text).
 * Text stays extractable (standard Type 1 fonts, no outlines), content streams are Flate-compressed, and other PDFs
 * (e.g. the digitally signed TRACES Part A) can be carried as embedded file attachments without altering them —
 * re-paginating a signed PDF would invalidate its signature, so the original is attached and also offered as-is.
 */
import { deflateSync } from "node:zlib";

export const A4 = { width: 595.28, height: 841.89 };
const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELVETICA_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

/** Text the standard fonts can show: ₹ → "Rs.", typographic punctuation → ASCII, anything else outside Latin-1 → "?". */
export function pdfSafe(value: unknown) {
  return String(value ?? "")
    .replace(/₹\s?/g, "Rs. ").replace(/[‐-―−]/g, "-").replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"').replace(/…/g, "...")
    .replace(/[•·]/g, "*").replace(/×/g, "x").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[^ -ÿ]/g, "?");
}

export function textWidth(text: string, size: number, bold = false) {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let width = 0;
  for (const char of pdfSafe(text)) { const code = char.charCodeAt(0); width += code >= 32 && code <= 126 ? table[code - 32] : 556; }
  return (width * size) / 1000;
}

/** Splits text into lines no wider than `width`. */
export function wrapText(text: string, width: number, size: number, bold = false) {
  const lines: string[] = [];
  for (const paragraph of pdfSafe(text).split(/\n/)) {
    let current = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word;
      if (textWidth(candidate, size, bold) <= width || !current) current = candidate;
      else { lines.push(current); current = word; }
    }
    lines.push(current);
  }
  return lines;
}

const escapeString = (text: string) => pdfSafe(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const rgb = (hex: string) => { const n = parseInt(hex.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3)).join(" "); };
const f = (n: number) => (Math.round(n * 100) / 100).toString();

export type TextOptions = { size?: number; bold?: boolean; color?: string; align?: "left" | "right" | "center"; width?: number };
export type Attachment = { name: string; bytes: Buffer; description?: string; mimeType?: string };

export class PdfDocument {
  private pages: string[][] = [];
  readonly margin = 40;
  y = 0;

  constructor(readonly meta: { title: string; subject?: string; author?: string }) { this.addPage(); }

  get page() { return this.pages[this.pages.length - 1]; }
  get pageCount() { return this.pages.length; }
  get contentWidth() { return A4.width - this.margin * 2; }

  addPage() { this.pages.push([]); this.y = A4.height - this.margin; }
  /** Starts a new page when fewer than `height` points remain above the footer. */
  ensure(height: number) { if (this.y - height < this.margin + 24) this.addPage(); }

  text(x: number, y: number, value: string, options: TextOptions = {}) {
    const size = options.size ?? 9;
    const bold = Boolean(options.bold);
    let left = x;
    if (options.align && options.align !== "left" && options.width !== undefined) {
      const width = textWidth(value, size, bold);
      left = options.align === "right" ? x + options.width - width : x + (options.width - width) / 2;
    }
    this.page.push(`BT /${bold ? "F2" : "F1"} ${f(size)} Tf ${rgb(options.color || "#17343e")} rg ${f(left)} ${f(y)} Td (${escapeString(value)}) Tj ET`);
  }
  line(x1: number, y1: number, x2: number, y2: number, color = "#d9d4c7", width = 0.6) {
    this.page.push(`${rgb(color)} RG ${f(width)} w ${f(x1)} ${f(y1)} m ${f(x2)} ${f(y2)} l S`);
  }
  rect(x: number, y: number, width: number, height: number, fill: string) {
    this.page.push(`${rgb(fill)} rg ${f(x)} ${f(y)} ${f(width)} ${f(height)} re f`);
  }
  /** Wrapped paragraph at the cursor. */
  paragraph(value: string, options: TextOptions & { gap?: number } = {}) {
    const size = options.size ?? 9;
    const width = options.width ?? this.contentWidth;
    for (const line of wrapText(value, width, size, options.bold)) {
      this.ensure(size + 3);
      this.y -= size + 3;
      this.text(this.margin, this.y, line, { ...options, size });
    }
    this.y -= options.gap ?? 4;
  }

  /** Serialises the document. `footer(page, total)` is drawn on every page. */
  toBuffer(options: { footer?: (page: number, total: number) => string; attachments?: Attachment[] } = {}) {
    const objects: (string | Buffer)[] = [];
    const add = (body: string | Buffer) => { objects.push(body); return objects.length; };
    const catalogId = add(""); const pagesId = add("");
    const font1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const font2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const pageIds: number[] = [];
    this.pages.forEach((ops, index) => {
      const all = [...ops];
      if (options.footer) {
        const label = options.footer(index + 1, this.pages.length);
        all.push(`${rgb("#d9d4c7")} RG 0.6 w ${f(this.margin)} ${f(this.margin + 14)} m ${f(A4.width - this.margin)} ${f(this.margin + 14)} l S`);
        all.push(`BT /F1 7 Tf ${rgb("#60757b")} rg ${f(this.margin)} ${f(this.margin + 4)} Td (${escapeString(label)}) Tj ET`);
      }
      const stream = deflateSync(Buffer.from(all.join("\n"), "latin1"));
      const contentId = add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), stream, Buffer.from("\nendstream", "latin1")]));
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> /Contents ${contentId} 0 R >>`));
    });
    const fileSpecs: string[] = [];
    for (const attachment of options.attachments || []) {
      const name = escapeString(attachment.name);
      const streamId = add(Buffer.concat([
        Buffer.from(`<< /Type /EmbeddedFile /Subtype /${(attachment.mimeType || "application/pdf").replace("/", "#2F")} /Length ${attachment.bytes.length} /Params << /Size ${attachment.bytes.length} >> >>\nstream\n`, "latin1"),
        attachment.bytes, Buffer.from("\nendstream", "latin1")]));
      const specId = add(`<< /Type /Filespec /F (${name}) /UF (${name}) /Desc (${escapeString(attachment.description || attachment.name)}) /EF << /F ${streamId} 0 R >> >>`);
      fileSpecs.push(`(${name}) ${specId} 0 R`);
    }
    const infoId = add(`<< /Title (${escapeString(this.meta.title)}) /Subject (${escapeString(this.meta.subject || "")}) /Author (${escapeString(this.meta.author || "")}) /Producer (Northstar HRM) >>`);
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
    objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R${fileSpecs.length ? ` /Names << /EmbeddedFiles << /Names [${fileSpecs.join(" ")}] >> >> /PageMode /UseAttachments` : ""} >>`;

    const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    let offset = chunks[0].length;
    const offsets: number[] = [];
    objects.forEach((body, index) => {
      offsets.push(offset);
      const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, "latin1"), typeof body === "string" ? Buffer.from(body, "latin1") : body, Buffer.from("\nendobj\n", "latin1")]);
      chunks.push(chunk); offset += chunk.length;
    });
    const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, "latin1"));
    return Buffer.concat(chunks);
  }
}
