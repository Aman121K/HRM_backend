/**
 * Controls from ISO/IEC 27001:2022 Annex A and the AICPA SOC 2 Trust Services Criteria that this HRM can support,
 * each mapped to the automated checks that produce evidence for it. Titles are short references; the descriptions are
 * our own summary of what the control means for this product. Controls with no checks rely on manual evidence
 * (procedures, documents, screenshots) recorded in the Compliance Center.
 */
export type Framework = "iso27001" | "soc2";
export type Control = { id: string; title: string; theme: string; description: string; checks: string[] };

export const FRAMEWORKS: Record<Framework, { name: string; short: string; description: string }> = {
  iso27001: { name: "ISO/IEC 27001:2022", short: "ISO 27001", description: "Information security management system — Annex A controls." },
  soc2: { name: "SOC 2 Type II", short: "SOC 2", description: "AICPA Trust Services Criteria — Security, Availability, Confidentiality, Privacy." },
};

export const CHECK_TITLES: Record<string, string> = {
  "demo-identity": "Demo sign-in disabled", "db-role": "Least-privilege database role", rls: "Row-level security on brand data",
  audit: "Append-only audit trail", "audit-chain": "Audit trail hash chain intact", sso: "Company SSO with MFA",
  "master-key": "Integration secrets key", "payout-secret": "Payout webhook secret", redis: "Shared rate limiting",
  smtp: "Outgoing email configured", https: "HTTPS everywhere", cors: "API restricted to own origins", "runtime-secret": "Separated database credentials",
  backups: "Encrypted backups with PITR", pentest: "Independent penetration test", "access-review": "Quarterly access review completed",
  "privileged-access": "Privileged accounts inventory", "orphaned-access": "No access for inactive people", "policy-acks": "Policies acknowledged by staff",
  "security-monitoring": "Denied-request monitoring active", "change-log": "Database change history", "data-retention": "Automatic data retention jobs",
  "sensitive-fields": "Sensitive identifiers encrypted", "file-storage": "Employee files in encrypted object storage",
};

const iso = (id: string, title: string, theme: string, description: string, checks: string[] = []): Control => ({ id, title, theme, description, checks });

export const CONTROLS: Record<Framework, Control[]> = {
  iso27001: [
    iso("A.5.1", "Policies for information security", "Organizational", "Security policies are approved, published to staff and acknowledged.", ["policy-acks"]),
    iso("A.5.2", "Information security roles and responsibilities", "Organizational", "Named owners for security, HR data and platform administration."),
    iso("A.5.3", "Segregation of duties", "Organizational", "Conflicting duties are split — e.g. payroll maker and checker are different people."),
    iso("A.5.9", "Inventory of information and assets", "Organizational", "Employee data, payroll and documents are inventoried with owners."),
    iso("A.5.15", "Access control", "Organizational", "Access to brand data is limited by role and enforced by the database.", ["db-role", "rls", "sso"]),
    iso("A.5.16", "Identity management", "Organizational", "Every person has one identity from the company identity provider.", ["sso", "demo-identity"]),
    iso("A.5.18", "Access rights", "Organizational", "Access is reviewed regularly and removed when no longer needed.", ["access-review", "orphaned-access"]),
    iso("A.5.23", "Information security for use of cloud services", "Organizational", "Hosting, database and email providers are assessed and contracted."),
    iso("A.5.24", "Incident management planning and preparation", "Organizational", "A written incident response plan with contacts and severity levels."),
    iso("A.5.28", "Collection of evidence", "Organizational", "Logs and evidence are collected in a way that prevents tampering.", ["audit", "audit-chain"]),
    iso("A.5.30", "ICT readiness for business continuity", "Organizational", "Backups and recovery are tested so payroll can run after an outage.", ["backups"]),
    iso("A.5.34", "Privacy and protection of PII", "Organizational", "Personal data is minimised, retained only as long as needed and protected.", ["data-retention", "sensitive-fields"]),
    iso("A.6.1", "Screening", "People", "Background checks for staff with privileged access."),
    iso("A.6.3", "Information security awareness, education and training", "People", "Staff complete security awareness training (can be delivered through the LMS).", ["policy-acks"]),
    iso("A.6.5", "Responsibilities after termination or change of employment", "People", "Access is removed when people leave or change role.", ["orphaned-access"]),
    iso("A.8.2", "Privileged access rights", "Technological", "Owner, HR admin and platform admin accounts are few, known and reviewed.", ["privileged-access", "access-review"]),
    iso("A.8.3", "Information access restriction", "Technological", "One brand can never read another brand's data.", ["rls", "db-role"]),
    iso("A.8.5", "Secure authentication", "Technological", "Sign-in only through SSO with MFA; no shared or demo logins in production.", ["sso", "demo-identity"]),
    iso("A.8.8", "Management of technical vulnerabilities", "Technological", "Dependencies are patched and the service is penetration tested.", ["pentest"]),
    iso("A.8.9", "Configuration management", "Technological", "Security configuration is checked continuously against a baseline.", ["https", "cors", "runtime-secret", "master-key"]),
    iso("A.8.12", "Data leakage prevention", "Technological", "Exports and downloads are limited to authorised roles and logged."),
    iso("A.8.13", "Information backup", "Technological", "Encrypted backups with point-in-time recovery and restore tests.", ["backups", "file-storage"]),
    iso("A.8.15", "Logging", "Technological", "Changes are logged to a tamper-evident, append-only audit trail.", ["audit", "audit-chain"]),
    iso("A.8.16", "Monitoring activities", "Technological", "Failed sign-ins, denied requests and rate limiting are monitored.", ["security-monitoring", "redis"]),
    iso("A.8.20", "Networks security", "Technological", "Only HTTPS, only the company's own web origins.", ["https", "cors"]),
    iso("A.8.24", "Use of cryptography", "Technological", "TLS in transit, encryption at rest and managed keys for secrets.", ["https", "master-key", "payout-secret", "sensitive-fields", "file-storage"]),
    iso("A.8.25", "Secure development life cycle", "Technological", "Code review, automated tests and security review before release."),
    iso("A.8.32", "Change management", "Technological", "Database and application changes are versioned and traceable.", ["change-log"]),
  ],
  soc2: [
    iso("CC1.1", "Commitment to integrity and ethical values", "Control environment", "Code of conduct and acceptable use are acknowledged by staff.", ["policy-acks"]),
    iso("CC1.4", "Commitment to competence", "Control environment", "Staff are trained for their security responsibilities."),
    iso("CC2.2", "Internal communication", "Communication", "Security policies and changes are communicated to everyone.", ["policy-acks"]),
    iso("CC3.2", "Risk identification and analysis", "Risk assessment", "Risks to the service are identified, rated and tracked to closure."),
    iso("CC4.1", "Ongoing evaluations", "Monitoring", "Controls are evaluated continuously by automated checks.", ["audit-chain", "security-monitoring"]),
    iso("CC5.2", "Technology general controls", "Control activities", "Technical controls for access, change and operations are defined.", ["db-role", "rls", "change-log"]),
    iso("CC5.3", "Policies and procedures", "Control activities", "Policies are published, versioned and acknowledged.", ["policy-acks"]),
    iso("CC6.1", "Logical access security", "Logical access", "Access to data is restricted by identity, role and brand.", ["db-role", "rls", "sso", "demo-identity"]),
    iso("CC6.2", "User registration and deregistration", "Logical access", "Accounts are created through HR and removed when people leave.", ["orphaned-access"]),
    iso("CC6.3", "Access modification and review", "Logical access", "Access changes are approved and access is reviewed each quarter.", ["access-review", "privileged-access"]),
    iso("CC6.6", "Protection against external threats", "Logical access", "Rate limiting, strict origins and security headers at the boundary.", ["redis", "cors", "https"]),
    iso("CC6.7", "Restriction of data transmission", "Logical access", "Data moves only over encrypted connections to approved parties.", ["https", "payout-secret"]),
    iso("CC6.8", "Prevention of unauthorized software", "Logical access", "Uploads are type-checked and endpoints are managed."),
    iso("CC7.1", "Detection of configuration changes and vulnerabilities", "System operations", "Configuration is checked daily against the security baseline.", ["runtime-secret", "master-key", "pentest"]),
    iso("CC7.2", "Monitoring for anomalies", "System operations", "Security events and the audit trail are monitored for anomalies.", ["security-monitoring", "audit", "audit-chain"]),
    iso("CC7.3", "Evaluation of security events", "System operations", "Suspicious events are triaged and escalated."),
    iso("CC7.4", "Incident response", "System operations", "Incidents are contained, communicated and reviewed."),
    iso("CC8.1", "Change management", "Change management", "Changes are authorised, tested, versioned and traceable.", ["change-log"]),
    iso("CC9.2", "Vendor and business partner risk", "Risk mitigation", "Hosting, email and payout providers are assessed."),
    iso("A1.2", "Backup and recovery infrastructure", "Availability", "Backups are encrypted and point-in-time recovery is enabled.", ["backups"]),
    iso("A1.3", "Recovery testing", "Availability", "Restores are rehearsed at least quarterly."),
    iso("C1.1", "Identification and protection of confidential information", "Confidentiality", "Payroll, bank and identity data are protected and isolated per brand.", ["rls", "sensitive-fields", "file-storage"]),
    iso("C1.2", "Disposal of confidential information", "Confidentiality", "Data is deleted automatically after its retention period.", ["data-retention"]),
    iso("P4.2", "Retention of personal information", "Privacy", "Personal data such as punch selfies is kept only as long as needed.", ["data-retention"]),
    iso("P6.1", "Disclosure to third parties", "Privacy", "Personal data is shared only with approved processors (bank, payroll, email)."),
  ],
};
