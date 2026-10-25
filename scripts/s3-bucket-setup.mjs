#!/usr/bin/env node
// Locks down the S3 bucket that holds employee files. Run once per bucket with an admin AWS profile
// (the application's own role should NOT have these permissions):
//
//   AWS_PROFILE=admin node scripts/s3-bucket-setup.mjs
//
// Reads FILES_S3_BUCKET / FILES_S3_REGION / FILES_S3_KMS_KEY_ID / FILES_S3_PREFIX from .env. Each step is applied
// independently and reported; S3-compatible stores that don't support a step (MinIO, R2) just show "skipped".
import "dotenv/config";
import {
  PutBucketEncryptionCommand, PutBucketLifecycleConfigurationCommand, PutBucketOwnershipControlsCommand, PutBucketPolicyCommand,
  PutBucketVersioningCommand, PutPublicAccessBlockCommand, S3Client,
} from "@aws-sdk/client-s3";

const bucket = process.env.FILES_S3_BUCKET;
if (!bucket) throw new Error("Set FILES_S3_BUCKET in .env first.");
const kmsKeyId = process.env.FILES_S3_KMS_KEY_ID;
const prefix = (process.env.FILES_S3_PREFIX || "").replace(/^\/+|\/+$/g, "");
const client = new S3Client({
  region: process.env.FILES_S3_REGION || process.env.AWS_REGION || "ap-south-1",
  endpoint: process.env.FILES_S3_ENDPOINT || undefined, forcePathStyle: process.env.FILES_S3_FORCE_PATH_STYLE === "true",
  credentials: process.env.FILES_S3_ACCESS_KEY_ID ? { accessKeyId: process.env.FILES_S3_ACCESS_KEY_ID, secretAccessKey: process.env.FILES_S3_SECRET_ACCESS_KEY } : undefined,
});

const steps = [
  ["Block all public access", new PutPublicAccessBlockCommand({ Bucket: bucket, PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } })],
  ["Disable ACLs (bucket owner owns every object)", new PutBucketOwnershipControlsCommand({ Bucket: bucket, OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] } })],
  [`Default encryption (${kmsKeyId ? "SSE-KMS" : "SSE-S3 AES-256"})`, new PutBucketEncryptionCommand({ Bucket: bucket, ServerSideEncryptionConfiguration: { Rules: [{
    ApplyServerSideEncryptionByDefault: kmsKeyId ? { SSEAlgorithm: "aws:kms", KMSMasterKeyID: kmsKeyId } : { SSEAlgorithm: "AES256" }, BucketKeyEnabled: Boolean(kmsKeyId) }] } })],
  ["Versioning (recover overwritten/deleted files)", new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } })],
  ["Lifecycle: expire old versions after 90 days, abort stale uploads", new PutBucketLifecycleConfigurationCommand({ Bucket: bucket, LifecycleConfiguration: { Rules: [{
    ID: "northstar-housekeeping", Status: "Enabled", Filter: { Prefix: prefix ? `${prefix}/` : "" },
    NoncurrentVersionExpiration: { NoncurrentDays: 90 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }] } })],
  ["Policy: HTTPS only, encrypted uploads only", new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify({ Version: "2012-10-17", Statement: [
    { Sid: "DenyInsecureTransport", Effect: "Deny", Principal: "*", Action: "s3:*", Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`], Condition: { Bool: { "aws:SecureTransport": "false" } } },
    { Sid: "DenyUnencryptedUploads", Effect: "Deny", Principal: "*", Action: "s3:PutObject", Resource: `arn:aws:s3:::${bucket}/*`, Condition: { Null: { "s3:x-amz-server-side-encryption": "true" } } },
  ] }) })],
];

let failed = 0;
for (const [label, command] of steps) {
  try { await client.send(command); console.log(`  ✓ ${label}`); }
  catch (error) {
    const unsupported = /NotImplemented|not implemented|MethodNotAllowed|InvalidRequest/i.test(`${error.name} ${error.message}`);
    if (unsupported) console.log(`  – ${label}: skipped (${error.name} — not supported by this store)`);
    else { failed += 1; console.log(`  ✗ ${label}: ${error.name}: ${error.message}`); }
  }
}
console.log(`\nApplication IAM policy (attach to the API / worker role — least privilege, this company folder layout only):`);
console.log(JSON.stringify({ Version: "2012-10-17", Statement: [
  { Effect: "Allow", Action: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], Resource: `arn:aws:s3:::${bucket}/${prefix ? `${prefix}/` : ""}tenants/*` },
  { Effect: "Allow", Action: ["s3:ListBucket"], Resource: `arn:aws:s3:::${bucket}`, Condition: { StringLike: { "s3:prefix": [`${prefix ? `${prefix}/` : ""}tenants/*`] } } },
  ...(kmsKeyId ? [{ Effect: "Allow", Action: ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"], Resource: kmsKeyId }] : []),
] }, null, 2));
process.exit(failed ? 1 : 0);
