// Receipt OCR providers behind one interface:
//  - anthropic  (ANTHROPIC_API_KEY set): Claude vision + structured JSON output; model ANTHROPIC_OCR_MODEL (default claude-haiku-5-5).
//  - tesseract  (offline default for images): tesseract.js with English traineddata cached under .data/ocr.
//  - pdf-text   (PDFs with a text layer): pdf-parse; image-only PDFs return a warning asking for a photo.
// tesseract and pdf-text feed their text through the Indian receipt parser (receipt-parser.ts).
import { Injectable, Logger, ServiceUnavailableException, type OnModuleDestroy } from "@nestjs/common";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { EXPENSE_CATEGORIES, guessCategory, parseReceiptText, type ExpenseCategory, type ReceiptFields, type ReceiptLine } from "./receipt-parser";

export type OcrProviderName = "tesseract" | "anthropic" | "pdf-text";
export type OcrResult = { provider: OcrProviderName; confidence: number; fields: ReceiptFields; lines: ReceiptLine[]; warnings: string[]; rawText: string | null };

const round3 = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";

// ---- tesseract --------------------------------------------------------------------------------------------------------

type TesseractWorker = { recognize(image: Buffer): Promise<{ data: { text: string; confidence: number } }>; terminate(): Promise<unknown> };

export class TesseractOcr {
  private worker?: Promise<TesseractWorker>;
  private readonly cachePath = resolve(process.env.OCR_DATA_PATH || join(process.cwd(), ".data", "ocr"));
  constructor(private readonly logger: Logger) {}

  private async getWorker(): Promise<TesseractWorker> {
    if (!this.worker) {
      this.worker = (async () => {
        await mkdir(this.cachePath, { recursive: true });
        const cached = existsSync(join(this.cachePath, "eng.traineddata")) || existsSync(join(this.cachePath, "eng.traineddata.gz"));
        const { createWorker } = await import("tesseract.js");
        const options: Record<string, unknown> = { cachePath: this.cachePath, errorHandler: (error: unknown) => this.logger.warn(`tesseract: ${String(error)}`) };
        if (process.env.TESSERACT_LANG_PATH) options.langPath = process.env.TESSERACT_LANG_PATH;
        const creating = createWorker("eng", 1, options) as unknown as Promise<TesseractWorker>;
        const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out loading the OCR engine")), cached ? 30_000 : 90_000).unref());
        try {
          return await Promise.race([creating, timeout]);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new ServiceUnavailableException(cached
            ? `The offline OCR engine failed to start (${reason}).`
            : `Offline OCR needs the English language data (eng.traineddata, ~5 MB) in ${this.cachePath}. It could not be downloaded (${reason}). ` +
              "Connect to the internet once, or copy eng.traineddata there, or set TESSERACT_LANG_PATH to a mirror.");
        }
      })();
      this.worker.catch(() => { this.worker = undefined; }); // retry on the next scan
    }
    return this.worker;
  }

  async scan(bytes: Buffer): Promise<OcrResult> {
    const worker = await this.getWorker();
    const { data } = await Promise.race([
      worker.recognize(bytes),
      new Promise<never>((_, reject) => setTimeout(() => reject(new ServiceUnavailableException("OCR timed out after 60 s.")), 60_000).unref()),
    ]);
    const parsed = parseReceiptText(data.text || "");
    const ocrConfidence = Math.max(0, Math.min(100, Number(data.confidence) || 0)) / 100;
    const warnings = [...parsed.warnings];
    if (ocrConfidence < 0.6 && (data.text || "").trim()) warnings.push("The photo was hard to read — check the extracted values or retake it in better light.");
    return { provider: "tesseract", confidence: round3(parsed.score * 0.6 + ocrConfidence * 0.4), fields: parsed.fields, lines: parsed.lines, warnings, rawText: data.text || "" };
  }

  async close() {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.then((value) => value.terminate()).catch(() => undefined);
  }
}

// ---- pdf-text ---------------------------------------------------------------------------------------------------------

export class PdfTextOcr {
  async scan(bytes: Buffer): Promise<OcrResult> {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    let text = "";
    try {
      const result = await parser.getText({ first: 3 });
      text = String(result.text || "");
    } finally {
      await parser.destroy().catch(() => undefined);
    }
    // pdf-parse appends "-- 1 of 2 --" page markers; drop them.
    text = text.replace(/^--\s*\d+\s+of\s+\d+\s*--$/gm, "").trim();
    if (text.replace(/\s/g, "").length < 20)
      return { provider: "pdf-text", confidence: 0, fields: {}, lines: [], rawText: text,
        warnings: ["This PDF is a scanned image without selectable text. Please upload a photo (JPG/PNG) of the receipt instead so it can be read."] };
    const parsed = parseReceiptText(text);
    // A text layer has no recognition errors, so confidence is driven by how many fields the parser found.
    return { provider: "pdf-text", confidence: round3(0.35 + parsed.score * 0.65), fields: parsed.fields, lines: parsed.lines, warnings: parsed.warnings, rawText: text };
  }
}

// ---- anthropic --------------------------------------------------------------------------------------------------------

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const RECEIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["merchant", "date", "total", "currency", "tax", "gstin", "invoiceNumber", "category", "lines", "confidence", "warnings"],
  properties: {
    merchant: nullable({ type: "string", description: "Business name as printed (brand, not the payment app)" }),
    date: nullable({ type: "string", format: "date", description: "Receipt/invoice date as YYYY-MM-DD (Indian receipts are day-first)" }),
    total: nullable({ type: "number", description: "Final amount paid/payable (Grand Total / Amount Payable), not a subtotal" }),
    currency: nullable({ type: "string", description: "ISO 4217 code, INR for ₹/Rs" }),
    tax: nullable({ type: "number", description: "Total GST/VAT (CGST+SGST or IGST)" }),
    gstin: nullable({ type: "string", description: "Seller GSTIN (15 characters)" }),
    invoiceNumber: nullable({ type: "string" }),
    category: { type: "string", enum: [...EXPENSE_CATEGORIES] },
    lines: { type: "array", items: { type: "object", additionalProperties: false, required: ["description", "amount"], properties: { description: { type: "string" }, amount: { type: "number" } } } },
    confidence: { type: "number", description: "0 to 1: how sure you are that total, date and merchant are right" },
    warnings: { type: "array", items: { type: "string" }, description: "Short notes for the employee, e.g. partly cut off, handwritten total" },
  },
} as const;

const SYSTEM_PROMPT = `You extract expense-claim data from receipts and invoices, mostly from India.
Read the document and return the JSON fields. Rules:
- total is the final amount the customer paid or must pay (Grand Total, Amount Payable, Total Paid, Net Amount), never a subtotal or taxable value.
- Dates on Indian receipts are day-first (05/09/2026 is 5 September 2026). Use the bill/invoice date, not a due date or a travel period end.
- tax is the total GST (CGST + SGST, or IGST, plus cess) when printed; otherwise null.
- category must be one of: ${EXPENSE_CATEGORIES.join(", ")}. Cabs/autos/metro/parking are Local travel; petrol/diesel/CNG are Fuel & mileage; restaurants, cafés and food delivery are Meals; mobile/broadband bills are Internet & phone.
- Use null for anything not printed on the document; do not guess numbers.
- If the image is not a receipt or is unreadable, return nulls, confidence 0 and a warning saying so.`;

export class AnthropicOcr {
  /** `client` is injectable for tests; production builds one from ANTHROPIC_API_KEY on first use. */
  constructor(private client?: Anthropic) {}
  get configured() { return !!process.env.ANTHROPIC_API_KEY; }
  get model() { return process.env.ANTHROPIC_OCR_MODEL || DEFAULT_ANTHROPIC_MODEL; }

  async scan(bytes: Buffer, mimeType: string): Promise<OcrResult> {
    this.client ||= new Anthropic({ timeout: 60_000, maxRetries: 2 });
    const data = bytes.toString("base64");
    const source: Anthropic.ContentBlockParam = mimeType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : { type: "image", source: { type: "base64", media_type: mimeType as "image/jpeg" | "image/png" | "image/webp", data } };
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: [source, { type: "text", text: "Extract the receipt fields." }] }],
      // Haiku 5.5 thinks by default (adaptive, effort "medium"); reading one receipt doesn't need deep reasoning, and low effort
      // keeps latency/cost down and leaves max_tokens for the JSON.
      output_config: { effort: "low", format: { type: "json_schema", schema: RECEIPT_SCHEMA as unknown as Record<string, unknown> } },
    });
    if (response.stop_reason === "refusal") throw new Error("the model declined to read this document");
    if (response.stop_reason === "max_tokens") throw new Error("the model response was cut off");
    const text = response.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    const raw = JSON.parse(text) as Record<string, unknown>;
    const fields: ReceiptFields = {};
    const str = (value: unknown, max = 120) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
    const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : undefined);
    fields.merchant = str(raw.merchant, 80);
    const date = str(raw.date, 10);
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date))) fields.date = date;
    fields.total = num(raw.total);
    fields.currency = (str(raw.currency, 3) || "INR").toUpperCase();
    fields.tax = num(raw.tax);
    const gstin = str(raw.gstin, 15)?.toUpperCase();
    if (gstin && /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) fields.gstin = gstin;
    fields.invoiceNumber = str(raw.invoiceNumber, 40);
    fields.category = EXPENSE_CATEGORIES.includes(raw.category as ExpenseCategory) ? raw.category as ExpenseCategory : guessCategory(JSON.stringify(raw));
    for (const key of Object.keys(fields) as (keyof ReceiptFields)[]) if (fields[key] === undefined) delete fields[key];
    const lines = Array.isArray(raw.lines)
      ? (raw.lines as { description?: unknown; amount?: unknown }[]).slice(0, 30).flatMap((line) => {
        const description = str(line.description); const amount = num(line.amount);
        return description && amount !== undefined ? [{ description, amount }] : [];
      })
      : [];
    const warnings = Array.isArray(raw.warnings) ? (raw.warnings as unknown[]).map((value) => str(value, 200)).filter(Boolean) as string[] : [];
    if (fields.total === undefined) warnings.push("Couldn't find the total amount — please enter it.");
    if (fields.currency && fields.currency !== "INR") warnings.push(`Amounts look like ${fields.currency}, not INR — claims are reimbursed in INR.`);
    return { provider: "anthropic", confidence: round3(Number(raw.confidence) || 0), fields, lines, warnings, rawText: null };
  }
}

// ---- selection --------------------------------------------------------------------------------------------------------

@Injectable()
export class OcrProviders implements OnModuleDestroy {
  private readonly logger = new Logger("ReceiptOcr");
  readonly tesseract = new TesseractOcr(this.logger);
  readonly pdfText = new PdfTextOcr();
  readonly anthropic = new AnthropicOcr();

  /** RECEIPT_OCR_PROVIDER=auto (default) | anthropic | tesseract. auto = anthropic when ANTHROPIC_API_KEY is set. */
  private preferAnthropic() {
    const choice = (process.env.RECEIPT_OCR_PROVIDER || "auto").toLowerCase();
    return this.anthropic.configured && (choice === "auto" || choice === "anthropic");
  }

  async scan(bytes: Buffer, mimeType: string): Promise<OcrResult> {
    if (this.preferAnthropic()) {
      try {
        return await this.anthropic.scan(bytes, mimeType);
      } catch (error) {
        const reason = error instanceof Anthropic.APIError ? `${error.status ?? ""} ${error.message}`.trim() : error instanceof Error ? error.message : String(error);
        this.logger.warn(JSON.stringify({ event: "anthropic_ocr_failed", model: this.anthropic.model, reason: reason.slice(0, 300) }));
        const local = await this.local(bytes, mimeType);
        return { ...local, warnings: ["AI extraction was unavailable, so the receipt was read offline — please double-check the values.", ...local.warnings] };
      }
    }
    return this.local(bytes, mimeType);
  }

  private local(bytes: Buffer, mimeType: string) {
    return mimeType === "application/pdf" ? this.pdfText.scan(bytes) : this.tesseract.scan(bytes);
  }

  async onModuleDestroy() { await this.tesseract.close(); }
}
