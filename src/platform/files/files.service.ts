import { BadRequestException, ForbiddenException, Injectable, InternalServerErrorException, Logger, NotFoundException, type OnModuleInit, PayloadTooLargeException, ServiceUnavailableException, UnsupportedMediaTypeException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { activeDriver, assertStorageConfigured, keyBelongsTo, objectKey, sha256Hex, storageFor, type StorageDriverName } from "./storage";

export type FileAccess = "read" | "write" | null;
/** Decides what the viewer may do with attachments of one record. Registered by the module that owns the record. */
export type FilePolicy = (identity: AuthIdentity, entityId: string, client: PoolClient) => Promise<FileAccess>;

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const TYPES: Record<string, { ext: string; magic: (bytes: Buffer) => boolean }> = {
  "application/pdf": { ext: "pdf", magic: (b) => b.subarray(0, 4).toString("latin1") === "%PDF" },
  "image/jpeg": { ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/png": { ext: "png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/webp": { ext: "webp", magic: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HR_ROLES = ["HR_ADMIN", "OWNER"];

export type UploadInput = { entityType: string; entityId: string; category?: string; originalName: string; mimeType: string; base64: string };

@Injectable()
export class FilesService implements OnModuleInit {
  private readonly logger = new Logger(FilesService.name);
  private readonly policies = new Map<string, FilePolicy>();

  constructor(private readonly database: DatabaseService) {}

  onModuleInit() {
    const driver = assertStorageConfigured();
    this.logger.log(`File storage: ${driver} (${storageFor(driver).location})`);
  }

  registerPolicy(entityType: string, policy: FilePolicy) { this.policies.set(entityType, policy); }

  list(identity: AuthIdentity, entityType: string, entityId: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      await this.require(identity, entityType, entityId, client, "read");
      const rows = (await client.query(
        `SELECT f.id, f.category, f.original_name AS "originalName", f.mime_type AS "mimeType", f.byte_size AS "byteSize",
                f.created_at AS "createdAt", f.uploaded_by AS "uploadedById", e.full_name AS "uploadedBy"
           FROM stored_files f JOIN employees e ON e.id=f.uploaded_by AND e.organization_id=f.organization_id
          WHERE f.organization_id=$1 AND f.entity_type=$2 AND f.entity_id=$3 AND f.deleted_at IS NULL ORDER BY f.created_at`,
        [identity.organizationId, entityType, entityId])).rows;
      return { items: rows };
    });
  }

  async upload(identity: AuthIdentity, input: UploadInput) {
    const type = TYPES[String(input.mimeType).toLowerCase()];
    if (!type) throw new UnsupportedMediaTypeException("Only PDF, JPEG, PNG and WebP files are supported.");
    const bytes = Buffer.from(String(input.base64 || "").replace(/^data:[^;]+;base64,/, ""), "base64");
    if (!bytes.length) throw new BadRequestException("The file is empty.");
    if (bytes.length > MAX_FILE_BYTES) throw new PayloadTooLargeException("Files must be 8 MB or smaller.");
    if (!type.magic(bytes)) throw new UnsupportedMediaTypeException("The file contents do not match its type.");
    const category = String(input.category || "ATTACHMENT").toUpperCase();
    if (!/^[A-Z0-9_]{2,40}$/.test(category)) throw new BadRequestException("Invalid file category.");
    const name = String(input.originalName || `file.${type.ext}`).replace(/[\r\n\\/]/g, " ").trim().slice(0, 180) || `file.${type.ext}`;
    const driver = activeDriver();
    const storage = storageFor(driver);
    const sha256 = sha256Hex(bytes);
    let written: string | null = null;
    try {
      return await this.database.tenantTransaction(identity, async (client) => {
      await this.require(identity, input.entityType, input.entityId, client, "write");
      const row = (await client.query(
        `INSERT INTO stored_files(organization_id,entity_type,entity_id,category,original_name,mime_type,byte_size,sha256,storage_key,storage_driver,uploaded_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'',$9,$10) RETURNING id, created_at AS "createdAt"`,
        [identity.organizationId, input.entityType, input.entityId, category, name, input.mimeType.toLowerCase(), bytes.length,
          sha256, driver, identity.employeeId])).rows[0];
      // Company folder: tenants/<organization>/<record type>/<category>/<yyyy>/<mm>/<file id>.<ext> — built from the
      // signed-in identity, never from request data.
      const key = objectKey({ organizationId: identity.organizationId, entityType: input.entityType, category, fileId: row.id, ext: type.ext, at: new Date(row.createdAt) });
      try { await storage.put(key, bytes, { contentType: input.mimeType.toLowerCase(), sha256, organizationId: identity.organizationId, fileId: row.id }); }
      catch (error) {
        this.logger.error(`Storage write failed for ${key}: ${(error as Error).message}`);
        throw new ServiceUnavailableException("The file couldn't be stored right now. Please try again.");
      }
      written = key;
      await client.query(`UPDATE stored_files SET storage_key=$1 WHERE id=$2`, [key, row.id]);
      await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'FILE_UPLOADED',$3,$4,$5)`,
        [identity.organizationId, identity.userId, input.entityType, input.entityId, JSON.stringify({ fileId: row.id, name, category, bytes: bytes.length })]);
      return { id: row.id, category, originalName: name, mimeType: input.mimeType.toLowerCase(), byteSize: bytes.length, createdAt: row.createdAt };
      });
    } catch (error) {
      // The database rolled back: remove the object we already wrote so storage never holds files without a record.
      if (written) await storage.delete(written).catch((cleanup) => this.logger.warn(`Orphan object ${written} not removed: ${(cleanup as Error).message}`));
      throw error;
    }
  }

  download(identity: AuthIdentity, id: string) {
    if (!UUID.test(id)) throw new NotFoundException("File not found.");
    return this.database.tenantTransaction(identity, async (client) => {
      const file = await this.find(identity, id, client);
      await this.require(identity, file.entity_type, file.entity_id, client, "read");
      const bytes = await this.readVerified(identity, file);
      // Read-audit: attachments are often ID proofs (PAN, Aadhaar, bank proof); every download leaves one audit row.
      await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'FILE_DOWNLOADED',$3,$4,$5)`,
        [identity.organizationId, identity.userId, file.entity_type, file.entity_id,
          JSON.stringify({ fileId: id, category: file.category, name: file.original_name, own: file.uploaded_by === identity.employeeId })]);
      return { name: file.original_name as string, mimeType: file.mime_type as string, bytes };
    });
  }

  remove(identity: AuthIdentity, id: string) {
    if (!UUID.test(id)) throw new NotFoundException("File not found.");
    return this.database.tenantTransaction(identity, async (client) => {
      const file = await this.find(identity, id, client);
      await this.require(identity, file.entity_type, file.entity_id, client, "write");
      if (file.uploaded_by !== identity.employeeId && !identity.roles.some((role) => HR_ROLES.includes(role)))
        throw new ForbiddenException("Only the uploader or HR can remove this file.");
      // Soft delete: bytes are retained for the audit/retention window and purged by a retention job.
      await client.query(`UPDATE stored_files SET deleted_at=now() WHERE id=$1`, [id]);
      await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'FILE_REMOVED',$3,$4,$5)`,
        [identity.organizationId, identity.userId, file.entity_type, file.entity_id, JSON.stringify({ fileId: id })]);
      return { id, deleted: true };
    });
  }

  /** For owning modules: count attachments inside an existing transaction (e.g. "receipt required"). */
  async count(client: PoolClient, identity: AuthIdentity, entityType: string, entityId: string) {
    return Number((await client.query(`SELECT count(*) FROM stored_files WHERE organization_id=$1 AND entity_type=$2 AND entity_id=$3 AND deleted_at IS NULL`,
      [identity.organizationId, entityType, entityId])).rows[0].count);
  }

  private async find(identity: AuthIdentity, id: string, client: PoolClient) {
    const file = (await client.query(`SELECT * FROM stored_files WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL`, [identity.organizationId, id])).rows[0];
    if (!file) throw new NotFoundException("File not found.");
    return file;
  }

  private async require(identity: AuthIdentity, entityType: string, entityId: string, client: PoolClient, need: "read" | "write") {
    const policy = this.policies.get(entityType);
    if (!policy || !UUID.test(String(entityId))) throw new NotFoundException("Record not found.");
    const access = await policy(identity, entityId, client);
    if (!access || (need === "write" && access !== "write")) {
      if (!access) throw new NotFoundException("Record not found.");
      throw new ForbiddenException("You can view but not change attachments on this record.");
    }
  }

  /** For owning modules (e.g. receipt OCR): the bytes of one file the caller may read, inside their transaction. */
  async readForProcessing(identity: AuthIdentity, id: string, client: PoolClient) {
    const file = await this.find(identity, id, client);
    return { bytes: await this.readVerified(identity, file), mimeType: file.mime_type as string, name: file.original_name as string };
  }

  /** Reads an object, refusing keys outside the caller's company folder and bytes that don't match the recorded SHA-256. */
  private async readVerified(identity: AuthIdentity, file: { id: string; storage_key: string; storage_driver?: string; sha256: string }) {
    if (!file.storage_key || !keyBelongsTo(file.storage_key, identity.organizationId)) {
      this.logger.error(`Blocked cross-tenant storage key for file ${file.id}`);
      throw new NotFoundException("File not found.");
    }
    const bytes = await storageFor((file.storage_driver || "local") as StorageDriverName).get(file.storage_key).catch((error) => {
      this.logger.error(`Storage read failed for file ${file.id}: ${(error as Error).message}`);
      throw new ServiceUnavailableException("The file is temporarily unavailable. Please try again.");
    });
    if (sha256Hex(bytes) !== String(file.sha256).trim()) {
      this.logger.error(`Integrity check failed for file ${file.id} (${file.storage_key})`);
      throw new InternalServerErrorException("This file failed its integrity check and was not served. The incident has been logged.");
    }
    return bytes;
  }
}
