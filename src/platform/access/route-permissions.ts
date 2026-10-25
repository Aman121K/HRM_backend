/**
 * Permission equivalents for existing `@Roles(...)` endpoints, keyed by `ControllerClass.handlerName`.
 *
 * RolesGuard keeps today's behaviour (the base role passes exactly as before) and additionally lets a request through
 * when the caller's effective permissions contain the equivalent listed here. Only endpoints whose services already
 * enforce row-level rules independent of the role are listed, so a custom role can WIDEN access safely and nobody
 * loses access they have today:
 *
 * - Leave approvals: the service only returns / decides requests where approver_id = the caller.
 * - Roster planning: the service rejects anyone outside the caller's direct reports unless the caller is HR.
 * - Attendance sites: organization-wide configuration; audited by the attendance service.
 * - Apply for leave: the caller's own leave only (also lets PAYROLL_ADMIN / OWNER apply, which @Roles omitted).
 *
 * Payroll run review/approval is mapped because RunsService re-checks (requireReviewer / requireAdmin per action).
 * LMS admin, engagement and case-engine services re-check base roles inside the service, so equivalents
 * there would not take effect; they are intentionally NOT listed (see the access README section in the report).
 */
export const ROUTE_PERMISSION_EQUIVALENTS: Record<string, string> = {
  "LeaveController.create": "leave.apply",
  "LeaveController.approvals": "leave.approve",
  "LeaveController.decide": "leave.approve",
  "AttendanceController.createSite": "attendance.sites.manage",
  "AttendanceController.updateSite": "attendance.sites.manage",
  "RosterController.save": "roster.plan",
  "RosterController.copy": "roster.plan",
  "RosterController.clear": "roster.plan",
  "RosterController.publish": "roster.plan",
  "RosterController.applyRequest": "roster.plan",
  // Payroll checkers: RunsService.requireReviewer allows viewing runs/lines and only approve/reject transitions.
  "PayrollController.listRuns": "payroll.run.approve",
  "PayrollController.getRun": "payroll.run.approve",
  "PayrollController.line": "payroll.run.approve",
  "PayrollController.transition": "payroll.run.approve",
};
