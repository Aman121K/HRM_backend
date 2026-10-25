/** Built-in checklist used to bootstrap an organization's first onboarding template. HR edits it afterwards. */
export type DefaultTask = {
  phase: "PRE_BOARDING" | "DAY_ONE" | "FIRST_WEEK" | "FIRST_90_DAYS";
  title: string; description: string; ownerType: "HR" | "IT" | "MANAGER" | "BUDDY" | "JOINER" | "FINANCE";
  dueOffsetDays: number; documentCategory?: "PAN" | "AADHAAR" | "BANK_PROOF" | "EDUCATION" | "PHOTO" | "OTHER"; completesOnConversion?: boolean;
};

export const DEFAULT_TEMPLATE_NAME = "Standard onboarding";
export const DEFAULT_TEMPLATE_DESCRIPTION = "Pre-boarding paperwork, a warm first day and structured check-ins through the first 90 days.";

export const DEFAULT_TASKS: DefaultTask[] = [
  { phase: "PRE_BOARDING", title: "Send welcome pack and joining instructions", ownerType: "HR", dueOffsetDays: -10, description: "Share the offer acceptance pack, first-day reporting time, address and dress code." },
  { phase: "PRE_BOARDING", title: "Submit PAN card", ownerType: "JOINER", dueOffsetDays: -7, documentCategory: "PAN", description: "A clear scan or photo of the PAN card. Needed for payroll and TDS." },
  { phase: "PRE_BOARDING", title: "Submit Aadhaar card", ownerType: "JOINER", dueOffsetDays: -7, documentCategory: "AADHAAR", description: "Front and back. Only the last four digits are kept on the record." },
  { phase: "PRE_BOARDING", title: "Submit bank account proof", ownerType: "JOINER", dueOffsetDays: -5, documentCategory: "BANK_PROOF", description: "Cancelled cheque or bank statement showing the account number and IFSC." },
  { phase: "PRE_BOARDING", title: "Submit education certificates", ownerType: "JOINER", dueOffsetDays: -5, documentCategory: "EDUCATION", description: "Highest qualification certificate or final mark sheet." },
  { phase: "PRE_BOARDING", title: "Submit a passport-size photo", ownerType: "JOINER", dueOffsetDays: -5, documentCategory: "PHOTO", description: "Used for the ID card and the employee directory." },
  { phase: "PRE_BOARDING", title: "Prepare devices, POS login and uniform", ownerType: "IT", dueOffsetDays: -3, description: "Laptop or tablet as per role, POS credentials for café roles, apron and uniform sizes." },
  { phase: "PRE_BOARDING", title: "Set up payroll and statutory details", ownerType: "FINANCE", dueOffsetDays: -2, description: "Add bank details, PF/ESI applicability and tax regime to payroll." },
  { phase: "DAY_ONE", title: "Create employee record and ID", ownerType: "HR", dueOffsetDays: 0, completesOnConversion: true, description: "Generated automatically when the joiner is converted to an employee." },
  { phase: "DAY_ONE", title: "Activate HRMS login and work email", ownerType: "IT", dueOffsetDays: 0, completesOnConversion: true, description: "Account is provisioned on conversion; confirm the joiner can sign in." },
  { phase: "DAY_ONE", title: "Welcome coffee and store tour with buddy", ownerType: "BUDDY", dueOffsetDays: 0, description: "Walk through the café or office, introduce the team and share the house rules." },
  { phase: "FIRST_WEEK", title: "Coffee fundamentals and food-safety training", ownerType: "JOINER", dueOffsetDays: 6, description: "Complete the assigned learning modules in the LMS." },
  { phase: "FIRST_WEEK", title: "First-week check-in", ownerType: "MANAGER", dueOffsetDays: 5, description: "15-minute conversation: what is going well, what is confusing, what support is needed." },
  { phase: "FIRST_90_DAYS", title: "30-day goals and feedback conversation", ownerType: "MANAGER", dueOffsetDays: 30, description: "Agree 60/90-day goals and share early feedback." },
  { phase: "FIRST_90_DAYS", title: "90-day probation review", ownerType: "MANAGER", dueOffsetDays: 90, description: "Confirm the probation outcome and record it with HR." },
];
