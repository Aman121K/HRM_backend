import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, type ServerSideEncryption } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Object storage for uploaded files (ID proofs, selfies, receipts, tax proofs).
 *
 * Every object lives under its company's own prefix:
 *   tenants/<organization_id>/<entity_type>/<category>/<yyyy>/<mm>/<file_id>.<ext>
 * The prefix is built on the server from the signed-in identity — never from user input — and every read re-checks
 * that the stored key belongs to the caller's organization, so one company can never address another company's files.
 *
 * Drivers: "local" (development: .data/uploads) and "s3" (AWS S3 or any S3-compatible store: MinIO, Cloudflare R2,
 * DigitalOcean Spaces). Rows remember their driver, so files can be migrated from local to S3 without downtime.
 */
export type StorageDriverName = "local" | "s3";
export type PutOptions = { contentType: string; sha256: string; organizationId: string; fileId: string };
export interface ObjectStorage {
  readonly name: StorageDriverName;
  readonly location: string;
  put(key: string, bytes: Buffer, options: PutOptions): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

const SEGMENT = /^[a-z0-9_]{2,40}$/;
const CATEGORY = /^[A-Z0-9_]{2,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The one place object keys are made. Every segment is validated, so a key can't escape its company's prefix. */
export function objectKey(input: { organizationId: string; entityType: string; category: string; fileId: string; ext: string; at?: Date }) {
  const at = input.at || new Date();
  if (!UUID.test(input.organizationId) || !UUID.test(input.fileId)) throw new Error("Invalid organization or file id for storage key.");
  if (!SEGMENT.test(input.entityType) || !CATEGORY.test(input.category) || !/^[a-z0-9]{2,5}$/.test(input.ext)) throw new Error("Invalid storage key segment.");
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `tenants/${input.organizationId.toLowerCase()}/${input.entityType}/${input.category.toLowerCase()}/${at.getUTCFullYear()}/${month}/${input.fileId.toLowerCase()}.${input.ext}`;
}

/** True when the key sits inside this organization's prefix (new layout) or its legacy local folder. */
export function keyBelongsTo(key: string, organizationId: string) {
  const org = organizationId.toLowerCase();
  const k = key.toLowerCase();
  if (k.includes("..") || k.includes("\\") || k.startsWith("/")) return false;
  return k.startsWith(`tenants/${org}/`) || k.startsWith(`${org}/`);
}

export const sha256Hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

class LocalStorage implements ObjectStorage {
  readonly name = "local" as const;
  readonly location: string;
  constructor(private readonly root = resolve(process.env.HRM_UPLOAD_PATH || join(process.cwd(), ".data", "uploads"))) { this.location = this.root; }
  private path(key: string) {
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new Error("Invalid storage path.");
    return path;
  }
  async put(key: string, bytes: Buffer) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  }
  get(key: string) { return readFile(this.path(key)); }
  async delete(key: string) { await unlink(this.path(key)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
  async exists(key: string) { return readFile(this.path(key)).then(() => true, () => false); }
}

export type S3Settings = {
  bucket: string; region: string; endpoint?: string; forcePathStyle: boolean; prefix: string;
  kmsKeyId?: string; accessKeyId?: string; secretAccessKey?: string;
  /** Server-side encryption: "aws:kms" when a KMS key is set, "AES256" on AWS, "none" for stores that encrypt on their own (R2). */
  sse: "aws:kms" | "AES256" | "none";
};

export function s3SettingsFromEnv(env = process.env): S3Settings | null {
  if (!env.FILES_S3_BUCKET) return null;
  return {
    bucket: env.FILES_S3_BUCKET,
    region: env.FILES_S3_REGION || env.AWS_REGION || "ap-south-1",
    endpoint: env.FILES_S3_ENDPOINT || undefined,
    forcePathStyle: env.FILES_S3_FORCE_PATH_STYLE === "true",
    // Optional environment prefix inside the bucket (e.g. "prod/"), so staging and production never share keys.
    prefix: (env.FILES_S3_PREFIX || "").replace(/^\/+|\/+$/g, "").replace(/(.)$/, "$1/"),
    kmsKeyId: env.FILES_S3_KMS_KEY_ID || undefined,
    // Prefer an IAM role (instance profile / IRSA / task role); static keys only for S3-compatible stores.
    accessKeyId: env.FILES_S3_ACCESS_KEY_ID || undefined,
    secretAccessKey: env.FILES_S3_SECRET_ACCESS_KEY || undefined,
    sse: env.FILES_S3_KMS_KEY_ID ? "aws:kms" : (env.FILES_S3_SSE as "AES256" | "none") || (env.FILES_S3_ENDPOINT ? "none" : "AES256"),
  };
}

class S3Storage implements ObjectStorage {
  readonly name = "s3" as const;
  readonly location: string;
  private readonly client: S3Client;
  constructor(private readonly settings: S3Settings) {
    this.location = `s3://${settings.bucket}/${settings.prefix}`;
    this.client = new S3Client({
      region: settings.region, endpoint: settings.endpoint, forcePathStyle: settings.forcePathStyle,
      credentials: settings.accessKeyId && settings.secretAccessKey ? { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey } : undefined,
      maxAttempts: 3,
    });
  }
  private full(key: string) { return `${this.settings.prefix}${key}`; }
  async put(key: string, bytes: Buffer, options: PutOptions) {
    const encryption: { ServerSideEncryption?: ServerSideEncryption; SSEKMSKeyId?: string } =
      this.settings.sse === "aws:kms" ? { ServerSideEncryption: "aws:kms", SSEKMSKeyId: this.settings.kmsKeyId }
        : this.settings.sse === "AES256" ? { ServerSideEncryption: "AES256" } : {};
    await this.client.send(new PutObjectCommand({
      Bucket: this.settings.bucket, Key: this.full(key), Body: bytes, ContentType: options.contentType, ContentLength: bytes.length,
      // S3 verifies the bytes it stored against this checksum and rejects the upload on mismatch.
      ChecksumSHA256: Buffer.from(options.sha256, "hex").toString("base64"),
      // Objects are private and never served directly: downloads stream through the API, which checks access and audits.
      ContentDisposition: "attachment", CacheControl: "private, no-store",
      Metadata: { "organization-id": options.organizationId, "file-id": options.fileId, sha256: options.sha256 },
      ...encryption,
    }));
  }
  async get(key: string) {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.settings.bucket, Key: this.full(key) }));
    if (!result.Body) throw new Error("Empty object body.");
    return Buffer.from(await result.Body.transformToByteArray());
  }
  async delete(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.settings.bucket, Key: this.full(key) })); }
  async exists(key: string) {
    return this.client.send(new HeadObjectCommand({ Bucket: this.settings.bucket, Key: this.full(key) })).then(() => true, (error: { name?: string; $metadata?: { httpStatusCode?: number } }) => {
      if (error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404) return false;
      throw error;
    });
  }
}

let local: LocalStorage | null = null;
let s3: S3Storage | null | undefined;

/** The driver new uploads go to: FILES_STORAGE=s3 (requires FILES_S3_BUCKET) or local (default in development). */
export function activeDriver(env = process.env): StorageDriverName {
  const wanted = (env.FILES_STORAGE || "local").toLowerCase();
  if (wanted !== "local" && wanted !== "s3") throw new Error(`FILES_STORAGE must be "local" or "s3", got "${wanted}".`);
  return wanted;
}

/** Driver for an existing row (rows keep the driver they were written with). */
export function storageFor(driver: StorageDriverName): ObjectStorage {
  if (driver === "local") return (local ||= new LocalStorage());
  if (s3 === undefined) { const settings = s3SettingsFromEnv(); s3 = settings ? new S3Storage(settings) : null; }
  if (!s3) throw new Error("FILES_STORAGE is s3 but FILES_S3_BUCKET is not configured.");
  return s3;
}

/** Fails fast at boot: production must store files in S3, and an s3 driver must be fully configured. */
export function assertStorageConfigured(env = process.env) {
  const driver = activeDriver(env);
  if (env.NODE_ENV === "production" && driver !== "s3") throw new Error("Production must use FILES_STORAGE=s3 — local disk is lost when a server is replaced and is not shared between instances.");
  if (driver === "s3") storageFor("s3");
  return driver;
}
