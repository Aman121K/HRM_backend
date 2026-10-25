// Feature modules registered with the platform API. Each lives in its own folder with its own module file.
import { AccessModule } from "./access/access.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { AttendanceModule } from "./attendance/attendance.module";
import { JobsModule } from "./jobs/jobs.module";
import { IntegrationsModule } from "./integrations/integrations.module";
import { EngagementModule } from "./engagement/engagement.module";
import { FilesModule } from "./files/files.module";
import { LmsModule } from "./lms/lms.module";
import { OnboardingModule } from "./onboarding/onboarding.module";
import { PayrollModule } from "./payroll/payroll.module";
import { RosterModule } from "./roster/roster.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { RiskModule } from "./risk/risk.module";
import { SecurityModule } from "./security/security.module";
import { ComplianceModule } from "./compliance/compliance.module";
import { ReceiptsModule } from "./receipts/receipts.module";
import { TaxModule } from "./tax/tax.module";
import { PeopleAdminModule } from "./people/people-admin.module";
import { OpsModule } from "./ops/ops.module";
import { ImportsModule } from "./imports/imports.module";
import { PayrollReturnsModule } from "./payroll-returns/returns.module";

import { BillingModule } from "./billing/billing.module";
import { NativeAuthModule } from "./auth/local/native-auth.module";
import { PrivacyModule } from "./privacy/privacy.module";
export const FEATURE_MODULES = [SecurityModule, FilesModule, JobsModule, AttendanceModule, AccessModule, IntegrationsModule, PayrollModule, EngagementModule, RosterModule, LmsModule, OnboardingModule, AnalyticsModule, ReceiptsModule, NotificationsModule, RiskModule, ComplianceModule, TaxModule, PeopleAdminModule, OpsModule, ImportsModule, PayrollReturnsModule, BillingModule, NativeAuthModule, PrivacyModule];
