// Declarative definitions for every request/approval module served by the case engine.
// The API publishes these definitions so the UI renders forms, badges and actions from one source of truth.

export type CaseActor = "requester" | "approver" | "assignee" | "hr";
export type Tone = "neutral" | "info" | "warning" | "success" | "danger";
export type CaseColumn = "title" | "category" | "priority" | "amount" | "startDate" | "endDate" | "subjectEmployeeId";

export type FieldDef = {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "money" | "date" | "time" | "select" | "employee" | "email";
  required?: boolean;
  options?: string[];
  column?: CaseColumn;
  placeholder?: string;
  help?: string;
  max?: number;
};
export type StatusDef = { key: string; label: string; tone: Tone; terminal?: boolean };
export type TransitionDef = {
  action: string;
  label: string;
  from: string[];
  to: string;
  by: CaseActor[];
  noteRequired?: boolean;
  fields?: FieldDef[];
  assignSelf?: boolean;
  /** Housekeeping (cancel, withdraw, hide) that should not count as work waiting on the viewer. */
  optional?: boolean;
  intent?: "primary" | "danger" | "neutral";
};
export type CaseModule = {
  key: string;
  label: string;
  singular: string;
  prefix: string;
  group: "Self service" | "Talent" | "Workplace";
  description: string;
  routing: "manager" | "hr" | "none";
  visibility: "private" | "public";
  publicStatuses?: string[];
  createRoles?: string[];
  singleOpen?: boolean;
  initial: string;
  statuses: StatusDef[];
  transitions: TransitionDef[];
  fields: FieldDef[];
  slaHours?: Record<"LOW" | "MEDIUM" | "HIGH" | "URGENT", number>;
  limits?: Record<string, number>;
};

const priority: FieldDef = { key: "priority", label: "Priority", type: "select", column: "priority", required: true, options: ["LOW", "MEDIUM", "HIGH", "URGENT"] };
const approve = (from = ["SUBMITTED"], to = "APPROVED"): TransitionDef => ({ action: "approve", label: "Approve", from, to, by: ["approver"], intent: "primary" });
const reject = (from = ["SUBMITTED"]): TransitionDef => ({ action: "reject", label: "Reject", from, to: "REJECTED", by: ["approver"], noteRequired: true, intent: "danger" });
const cancel = (from: string[], to = "CANCELLED", label = "Cancel request"): TransitionDef => ({ action: "cancel", label, from, to, by: ["requester"], intent: "neutral", optional: true });

export const caseModules: CaseModule[] = [
  {
    key: "regularization", label: "Attendance corrections", singular: "correction", prefix: "REG", group: "Self service", routing: "manager", visibility: "private",
    description: "Fix a missed or wrong punch. Your manager approves, and the corrected times are kept with a full audit trail.",
    initial: "SUBMITTED",
    statuses: [
      { key: "SUBMITTED", label: "Awaiting approval", tone: "info" }, { key: "APPROVED", label: "Approved", tone: "success", terminal: true },
      { key: "REJECTED", label: "Rejected", tone: "danger", terminal: true }, { key: "CANCELLED", label: "Cancelled", tone: "neutral", terminal: true },
    ],
    transitions: [approve(), reject(), cancel(["SUBMITTED"])],
    fields: [
      { key: "startDate", label: "Date to correct", type: "date", column: "startDate", required: true },
      { key: "category", label: "What happened?", type: "select", column: "category", required: true, options: ["Forgot to punch in", "Forgot to punch out", "App or device issue", "Worked at another site", "On official duty outside"] },
      { key: "expectedIn", label: "Actual in time", type: "time", required: true },
      { key: "expectedOut", label: "Actual out time", type: "time" },
      { key: "title", label: "Reason", type: "text", column: "title", required: true, placeholder: "e.g. Phone battery died during opening shift", max: 200 },
    ],
  },
  {
    key: "helpdesk", label: "Helpdesk", singular: "ticket", prefix: "HD", group: "Self service", routing: "hr", visibility: "private",
    description: "Raise a query with HR, payroll, IT or facilities and track it to resolution against an SLA.",
    initial: "OPEN", slaHours: { LOW: 72, MEDIUM: 48, HIGH: 24, URGENT: 4 },
    statuses: [
      { key: "OPEN", label: "Open", tone: "info" }, { key: "IN_PROGRESS", label: "In progress", tone: "warning" },
      { key: "WAITING", label: "Awaiting employee", tone: "neutral" }, { key: "RESOLVED", label: "Resolved", tone: "success" },
      { key: "CLOSED", label: "Closed", tone: "neutral", terminal: true }, { key: "CANCELLED", label: "Cancelled", tone: "neutral", terminal: true },
    ],
    transitions: [
      { action: "pick_up", label: "Pick up ticket", from: ["OPEN"], to: "IN_PROGRESS", by: ["hr"], assignSelf: true, intent: "primary" },
      { action: "request_info", label: "Ask employee", from: ["IN_PROGRESS"], to: "WAITING", by: ["assignee", "hr"], noteRequired: true },
      { action: "respond", label: "Send reply", from: ["WAITING"], to: "IN_PROGRESS", by: ["requester"], noteRequired: true, intent: "primary" },
      { action: "resolve", label: "Mark resolved", from: ["IN_PROGRESS"], to: "RESOLVED", by: ["assignee", "hr"], noteRequired: true, intent: "primary" },
      { action: "close", label: "Confirm & close", from: ["RESOLVED"], to: "CLOSED", by: ["requester"], intent: "primary" },
      { action: "reopen", label: "Reopen", from: ["RESOLVED"], to: "OPEN", by: ["requester"], noteRequired: true },
      cancel(["OPEN", "WAITING"], "CANCELLED", "Cancel ticket"),
    ],
    fields: [
      { key: "category", label: "Category", type: "select", column: "category", required: true, options: ["IT & systems", "Payroll & tax", "Leave & attendance", "Policies", "Facilities", "Benefits & insurance", "Grievance (confidential)", "Other"] },
      priority,
      { key: "title", label: "Subject", type: "text", column: "title", required: true, placeholder: "e.g. Salary credited short for September", max: 200 },
      { key: "description", label: "Describe the issue", type: "textarea", required: true, max: 4000 },
    ],
  },
  {
    key: "assets", label: "Assets", singular: "asset request", prefix: "AST", group: "Workplace", routing: "manager", visibility: "private",
    description: "Request work equipment, track what is assigned to you and hand it back at the end.",
    initial: "REQUESTED",
    statuses: [
      { key: "REQUESTED", label: "Requested", tone: "info" }, { key: "APPROVED", label: "Approved", tone: "warning" },
      { key: "ALLOCATED", label: "Allocated", tone: "success" }, { key: "RETURN_REQUESTED", label: "Return initiated", tone: "warning" },
      { key: "RETURNED", label: "Returned", tone: "neutral", terminal: true }, { key: "REJECTED", label: "Rejected", tone: "danger", terminal: true },
      { key: "CANCELLED", label: "Cancelled", tone: "neutral", terminal: true },
    ],
    transitions: [
      approve(["REQUESTED"]), reject(["REQUESTED"]),
      { action: "allocate", label: "Allocate asset", from: ["APPROVED"], to: "ALLOCATED", by: ["hr"], intent: "primary", fields: [
        { key: "assetTag", label: "Asset tag", type: "text", required: true, placeholder: "BT-LAP-0142" },
        { key: "serialNumber", label: "Serial number", type: "text" },
      ] },
      { action: "request_return", label: "Initiate return", from: ["ALLOCATED"], to: "RETURN_REQUESTED", by: ["requester", "hr"], optional: true },
      { action: "confirm_return", label: "Confirm return", from: ["RETURN_REQUESTED"], to: "RETURNED", by: ["hr"], intent: "primary", fields: [
        { key: "returnCondition", label: "Condition on return", type: "select", required: true, options: ["Good", "Minor wear", "Damaged", "Lost"] },
      ] },
      cancel(["REQUESTED"]),
    ],
    fields: [
      { key: "category", label: "Asset type", type: "select", column: "category", required: true, options: ["Laptop", "Mobile phone", "Monitor", "POS terminal", "Access card", "Uniform kit", "Brewing equipment", "Other"] },
      { key: "title", label: "What do you need?", type: "text", column: "title", required: true, placeholder: "e.g. 14-inch laptop for store reporting", max: 200 },
      { key: "startDate", label: "Needed by", type: "date", column: "startDate" },
      { key: "justification", label: "Business justification", type: "textarea", required: true, max: 2000 },
    ],
  },
  {
    key: "expenses", label: "Expenses", singular: "claim", prefix: "EXP", group: "Self service", routing: "manager", visibility: "private",
    description: "Claim business expenses with policy limits applied before your manager and finance see them.",
    initial: "SUBMITTED",
    limits: { "Local travel": 8000, "Fuel & mileage": 6000, Meals: 1500, "Client entertainment": 10000, "Internet & phone": 1500, Learning: 30000, "Store supplies": 5000, Other: 5000 },
    statuses: [
      { key: "SUBMITTED", label: "Awaiting approval", tone: "info" }, { key: "SENT_BACK", label: "Sent back", tone: "warning" },
      { key: "APPROVED", label: "Approved · awaiting payment", tone: "warning" }, { key: "PAID", label: "Paid", tone: "success", terminal: true },
      { key: "REJECTED", label: "Rejected", tone: "danger", terminal: true }, { key: "WITHDRAWN", label: "Withdrawn", tone: "neutral", terminal: true },
    ],
    transitions: [
      approve(), { action: "send_back", label: "Send back", from: ["SUBMITTED"], to: "SENT_BACK", by: ["approver"], noteRequired: true }, reject(),
      { action: "resubmit", label: "Resubmit", from: ["SENT_BACK"], to: "SUBMITTED", by: ["requester"], noteRequired: true, intent: "primary" },
      { action: "pay", label: "Mark paid", from: ["APPROVED"], to: "PAID", by: ["hr"], intent: "primary", fields: [
        { key: "paymentReference", label: "Payment reference / UTR", type: "text", required: true },
      ] },
      cancel(["SUBMITTED", "SENT_BACK"], "WITHDRAWN", "Withdraw claim"),
    ],
    fields: [
      { key: "category", label: "Expense category", type: "select", column: "category", required: true, options: ["Local travel", "Fuel & mileage", "Meals", "Client entertainment", "Internet & phone", "Learning", "Store supplies", "Other"] },
      { key: "title", label: "Claim title", type: "text", column: "title", required: true, placeholder: "e.g. Vendor visit — Chikmagalur estate", max: 200 },
      { key: "amount", label: "Amount (₹)", type: "money", column: "amount", required: true },
      { key: "startDate", label: "Expense date", type: "date", column: "startDate", required: true },
      { key: "merchant", label: "Merchant / vendor", type: "text" },
      { key: "description", label: "Notes for approver", type: "textarea", max: 2000 },
    ],
  },
  {
    key: "travel", label: "Travel", singular: "travel request", prefix: "TRV", group: "Self service", routing: "manager", visibility: "private",
    description: "Get business travel approved and booked, with cost estimates visible up front.",
    initial: "SUBMITTED",
    statuses: [
      { key: "SUBMITTED", label: "Awaiting approval", tone: "info" }, { key: "APPROVED", label: "Approved · booking", tone: "warning" },
      { key: "BOOKED", label: "Booked", tone: "success" }, { key: "COMPLETED", label: "Completed", tone: "neutral", terminal: true },
      { key: "REJECTED", label: "Rejected", tone: "danger", terminal: true }, { key: "CANCELLED", label: "Cancelled", tone: "neutral", terminal: true },
    ],
    transitions: [
      approve(), reject(),
      { action: "book", label: "Confirm booking", from: ["APPROVED"], to: "BOOKED", by: ["hr"], intent: "primary", fields: [
        { key: "bookingReference", label: "Booking reference / PNR", type: "text", required: true },
      ] },
      { action: "complete", label: "Mark trip complete", from: ["BOOKED"], to: "COMPLETED", by: ["requester", "hr"] },
      cancel(["SUBMITTED", "APPROVED"], "CANCELLED", "Cancel trip"),
    ],
    fields: [
      { key: "title", label: "Purpose of travel", type: "text", column: "title", required: true, placeholder: "e.g. New café launch — Hyderabad", max: 200 },
      { key: "fromCity", label: "From", type: "text", required: true },
      { key: "toCity", label: "To", type: "text", required: true },
      { key: "startDate", label: "Departure", type: "date", column: "startDate", required: true },
      { key: "endDate", label: "Return", type: "date", column: "endDate", required: true },
      { key: "category", label: "Travel mode", type: "select", column: "category", required: true, options: ["Flight", "Train", "Bus", "Cab", "Self-drive"] },
      { key: "accommodation", label: "Accommodation", type: "select", options: ["Not needed", "Company guest house", "Hotel"] },
      { key: "amount", label: "Estimated cost (₹)", type: "money", column: "amount" },
    ],
  },
  {
    key: "learning", label: "Learning", singular: "training request", prefix: "TRN", group: "Talent", routing: "manager", visibility: "private",
    description: "Request training and certifications, get nominated, and record completion on your profile.",
    initial: "REQUESTED",
    statuses: [
      { key: "REQUESTED", label: "Requested", tone: "info" }, { key: "APPROVED", label: "Approved", tone: "warning" },
      { key: "ENROLLED", label: "Enrolled", tone: "success" }, { key: "COMPLETED", label: "Completed", tone: "success", terminal: true },
      { key: "REJECTED", label: "Rejected", tone: "danger", terminal: true }, { key: "CANCELLED", label: "Cancelled", tone: "neutral", terminal: true },
    ],
    transitions: [
      approve(["REQUESTED"]), reject(["REQUESTED"]),
      { action: "enroll", label: "Confirm enrolment", from: ["APPROVED"], to: "ENROLLED", by: ["hr"], intent: "primary" },
      { action: "complete", label: "Record completion", from: ["ENROLLED"], to: "COMPLETED", by: ["requester", "hr"], intent: "primary", fields: [
        { key: "certificateId", label: "Certificate ID (optional)", type: "text" },
      ] },
      cancel(["REQUESTED", "APPROVED"]),
    ],
    fields: [
      { key: "title", label: "Course or programme", type: "text", column: "title", required: true, placeholder: "e.g. SCA Barista Skills — Intermediate", max: 200 },
      { key: "category", label: "Area", type: "select", column: "category", required: true, options: ["Coffee craft", "Customer service", "Leadership", "Food safety", "Technology", "Compliance", "Other"] },
      { key: "provider", label: "Provider", type: "text" },
      { key: "startDate", label: "Starts", type: "date", column: "startDate" },
      { key: "endDate", label: "Ends", type: "date", column: "endDate" },
      { key: "amount", label: "Fee (₹)", type: "money", column: "amount" },
      { key: "description", label: "How will this help your role?", type: "textarea", required: true, max: 2000 },
    ],
  },
  {
    key: "shifts", label: "Shifts", singular: "shift request", prefix: "SFT", group: "Workplace", routing: "manager", visibility: "private",
    description: "Request a shift change or a swap with a colleague; your manager approves before the roster updates.",
    initial: "SUBMITTED",
    statuses: [
      { key: "SUBMITTED", label: "Awaiting approval", tone: "info" }, { key: "APPROVED", label: "Approved", tone: "success", terminal: true },
      { key: "REJECTED", label: "Rejected", tone: "danger", terminal: true }, { key: "CANCELLED", label: "Cancelled", tone: "neutral", terminal: true },
    ],
    transitions: [approve(), reject(), cancel(["SUBMITTED"])],
    fields: [
      { key: "category", label: "Requested shift", type: "select", column: "category", required: true, options: ["Opening · 07:00–15:00", "Mid · 11:00–19:00", "Closing · 15:00–23:00", "Weekly off"] },
      { key: "startDate", label: "From", type: "date", column: "startDate", required: true },
      { key: "endDate", label: "Until", type: "date", column: "endDate" },
      { key: "subjectEmployeeId", label: "Swap with colleague (optional)", type: "employee", column: "subjectEmployeeId" },
      { key: "title", label: "Reason", type: "text", column: "title", required: true, placeholder: "e.g. College exam in the morning", max: 200 },
    ],
  },
  {
    key: "letters", label: "Letters", singular: "letter request", prefix: "LTR", group: "Self service", routing: "hr", visibility: "private",
    description: "Request salary certificates, employment verification and other official letters from HR.",
    initial: "REQUESTED",
    statuses: [
      { key: "REQUESTED", label: "Requested", tone: "info" }, { key: "IN_PROGRESS", label: "Being prepared", tone: "warning" },
      { key: "ISSUED", label: "Issued", tone: "success", terminal: true }, { key: "REJECTED", label: "Declined", tone: "danger", terminal: true },
      { key: "CANCELLED", label: "Cancelled", tone: "neutral", terminal: true },
    ],
    transitions: [
      { action: "pick_up", label: "Start preparing", from: ["REQUESTED"], to: "IN_PROGRESS", by: ["hr"], assignSelf: true, intent: "primary" },
      { action: "issue", label: "Issue letter", from: ["IN_PROGRESS"], to: "ISSUED", by: ["hr", "assignee"], intent: "primary", fields: [
        { key: "letterReference", label: "Letter reference number", type: "text", required: true },
      ] },
      { action: "decline", label: "Decline", from: ["REQUESTED", "IN_PROGRESS"], to: "REJECTED", by: ["hr"], noteRequired: true, intent: "danger", optional: true },
      cancel(["REQUESTED"]),
    ],
    fields: [
      { key: "category", label: "Letter type", type: "select", column: "category", required: true, options: ["Salary certificate", "Employment verification", "Address proof letter", "Experience letter", "Visa support letter", "No objection certificate"] },
      { key: "title", label: "Addressed to", type: "text", column: "title", required: true, placeholder: "e.g. HDFC Bank, Koramangala branch", max: 200 },
      { key: "purpose", label: "Purpose", type: "textarea", required: true, max: 1000 },
      { key: "deliveryMode", label: "Delivery", type: "select", required: true, options: ["Digital (signed PDF)", "Printed copy"] },
    ],
  },
  {
    key: "recognition", label: "Recognition", singular: "kudos", prefix: "KUD", group: "Workplace", routing: "none", visibility: "public",
    description: "Thank a colleague publicly for living the company values.",
    initial: "PUBLISHED",
    statuses: [{ key: "PUBLISHED", label: "Published", tone: "success" }, { key: "HIDDEN", label: "Hidden by HR", tone: "neutral", terminal: true }],
    publicStatuses: ["PUBLISHED"],
    transitions: [{ action: "hide", label: "Hide from wall", from: ["PUBLISHED"], to: "HIDDEN", by: ["hr"], noteRequired: true, intent: "danger", optional: true }],
    fields: [
      { key: "subjectEmployeeId", label: "Who are you recognising?", type: "employee", column: "subjectEmployeeId", required: true },
      { key: "category", label: "Value", type: "select", column: "category", required: true, options: ["Customer first", "Craft & quality", "Team player", "Ownership", "Innovation"] },
      { key: "title", label: "Headline", type: "text", column: "title", required: true, placeholder: "e.g. Saved the Saturday rush single-handed", max: 200 },
      { key: "message", label: "Message", type: "textarea", required: true, max: 1000 },
    ],
  },
  {
    key: "requisitions", label: "Job openings", singular: "job requisition", prefix: "REQ", group: "Talent", routing: "hr", visibility: "public",
    description: "Raise hiring requisitions for approval; approved roles appear on the internal job board for applications and referrals.",
    initial: "PENDING_APPROVAL", publicStatuses: ["OPEN"], createRoles: ["MANAGER", "HR_ADMIN", "OWNER"],
    statuses: [
      { key: "PENDING_APPROVAL", label: "Pending HR approval", tone: "info" }, { key: "OPEN", label: "Open", tone: "success" },
      { key: "ON_HOLD", label: "On hold", tone: "warning" }, { key: "FILLED", label: "Filled", tone: "neutral", terminal: true },
      { key: "CANCELLED", label: "Cancelled", tone: "neutral", terminal: true },
    ],
    transitions: [
      { action: "approve", label: "Approve & publish", from: ["PENDING_APPROVAL"], to: "OPEN", by: ["hr"], intent: "primary" },
      { action: "hold", label: "Put on hold", from: ["OPEN"], to: "ON_HOLD", by: ["hr", "requester"], noteRequired: true, optional: true },
      { action: "resume", label: "Reopen role", from: ["ON_HOLD"], to: "OPEN", by: ["hr"], intent: "primary" },
      { action: "fill", label: "Mark filled", from: ["OPEN"], to: "FILLED", by: ["hr"], intent: "primary" },
      { action: "cancel", label: "Cancel requisition", from: ["PENDING_APPROVAL", "OPEN", "ON_HOLD"], to: "CANCELLED", by: ["hr", "requester"], noteRequired: true, intent: "danger", optional: true },
    ],
    fields: [
      { key: "title", label: "Job title", type: "text", column: "title", required: true, placeholder: "e.g. Café Manager", max: 200 },
      { key: "category", label: "Department", type: "select", column: "category", required: true, options: ["Cafe Operations", "Retail Operations", "Roastery", "Supply Chain", "Technology", "Marketing", "Finance", "People"] },
      { key: "location", label: "Location", type: "text", required: true, placeholder: "e.g. Bengaluru — Indiranagar" },
      { key: "openings", label: "Openings", type: "number", required: true, max: 500 },
      { key: "employmentType", label: "Employment type", type: "select", required: true, options: ["Full-time", "Part-time", "Contract", "Internship"] },
      { key: "amount", label: "Budgeted CTC per year (₹)", type: "money", column: "amount" },
      { key: "description", label: "Role summary", type: "textarea", required: true, max: 4000 },
    ],
  },
  {
    key: "candidates", label: "Candidates", singular: "candidate", prefix: "CAN", group: "Talent", routing: "hr", visibility: "private",
    description: "Refer people you know or add applicants, then move them through screening, interviews and offer.",
    initial: "APPLIED",
    statuses: [
      { key: "APPLIED", label: "New", tone: "info" }, { key: "SCREENING", label: "Screening", tone: "warning" },
      { key: "INTERVIEW", label: "Interviewing", tone: "warning" }, { key: "OFFERED", label: "Offer extended", tone: "success" },
      { key: "HIRED", label: "Hired", tone: "success", terminal: true }, { key: "REJECTED", label: "Not selected", tone: "danger", terminal: true },
      { key: "WITHDRAWN", label: "Withdrew", tone: "neutral", terminal: true },
    ],
    transitions: [
      { action: "screen", label: "Move to screening", from: ["APPLIED"], to: "SCREENING", by: ["hr"], intent: "primary" },
      { action: "interview", label: "Schedule interview", from: ["SCREENING"], to: "INTERVIEW", by: ["hr"], intent: "primary", fields: [
        { key: "interviewDate", label: "Interview date", type: "date", required: true },
        { key: "interviewer", label: "Interviewer", type: "text", required: true },
      ] },
      { action: "offer", label: "Extend offer", from: ["INTERVIEW"], to: "OFFERED", by: ["hr"], intent: "primary", fields: [
        { key: "amount", label: "Offered CTC per year (₹)", type: "money", column: "amount", required: true },
      ] },
      { action: "hire", label: "Mark hired", from: ["OFFERED"], to: "HIRED", by: ["hr"], intent: "primary", fields: [
        { key: "joiningDate", label: "Joining date", type: "date", required: true },
      ] },
      { action: "reject", label: "Not selected", from: ["APPLIED", "SCREENING", "INTERVIEW"], to: "REJECTED", by: ["hr"], noteRequired: true, intent: "danger" },
      { action: "withdraw", label: "Candidate withdrew", from: ["SCREENING", "INTERVIEW", "OFFERED"], to: "WITHDRAWN", by: ["hr"], noteRequired: true, optional: true },
    ],
    fields: [
      { key: "title", label: "Candidate name", type: "text", column: "title", required: true, max: 200 },
      { key: "email", label: "Email", type: "email", required: true },
      { key: "phone", label: "Phone", type: "text" },
      { key: "position", label: "Role applied for", type: "text", required: true, placeholder: "e.g. Barista — Bengaluru" },
      { key: "category", label: "Source", type: "select", column: "category", required: true, options: ["Employee referral", "Careers page", "Job portal", "Walk-in", "Agency"] },
      { key: "experienceYears", label: "Experience (years)", type: "number", max: 60 },
      { key: "notes", label: "Notes", type: "textarea", max: 2000 },
    ],
  },
  {
    key: "exit", label: "Exit", singular: "resignation", prefix: "EXT", group: "Self service", routing: "manager", visibility: "private", singleOpen: true,
    description: "Submit a resignation, agree the last working day, and complete clearance and final settlement.",
    initial: "SUBMITTED",
    statuses: [
      { key: "SUBMITTED", label: "Awaiting approval", tone: "info" }, { key: "ACCEPTED", label: "Accepted · notice period", tone: "warning" },
      { key: "CLEARANCE", label: "Clearance", tone: "warning" }, { key: "SETTLEMENT", label: "Final settlement", tone: "warning" },
      { key: "COMPLETED", label: "Exit completed", tone: "neutral", terminal: true }, { key: "RETAINED", label: "Retained", tone: "success", terminal: true },
      { key: "WITHDRAWN", label: "Withdrawn", tone: "neutral", terminal: true },
    ],
    transitions: [
      { action: "accept", label: "Accept resignation", from: ["SUBMITTED"], to: "ACCEPTED", by: ["approver"], intent: "primary", fields: [
        { key: "endDate", label: "Agreed last working day", type: "date", column: "endDate", required: true },
      ] },
      { action: "retain", label: "Retained after discussion", from: ["SUBMITTED"], to: "RETAINED", by: ["approver"], noteRequired: true },
      { action: "start_clearance", label: "Start clearance", from: ["ACCEPTED"], to: "CLEARANCE", by: ["hr"], intent: "primary" },
      { action: "start_settlement", label: "Clearance done → settlement", from: ["CLEARANCE"], to: "SETTLEMENT", by: ["hr"], intent: "primary", fields: [
        { key: "amount", label: "Full & final amount (₹)", type: "money", column: "amount", required: true },
      ] },
      { action: "complete", label: "Complete exit", from: ["SETTLEMENT"], to: "COMPLETED", by: ["hr"], intent: "primary" },
      cancel(["SUBMITTED", "ACCEPTED"], "WITHDRAWN", "Withdraw resignation"),
    ],
    fields: [
      { key: "category", label: "Primary reason", type: "select", column: "category", required: true, options: ["Career growth", "Higher studies", "Relocation", "Compensation", "Personal", "Health", "Other"] },
      { key: "endDate", label: "Proposed last working day", type: "date", column: "endDate", required: true },
      { key: "title", label: "Summary", type: "text", column: "title", required: true, placeholder: "e.g. Relocating to Pune", max: 200 },
      { key: "message", label: "Message to your manager", type: "textarea", required: true, max: 4000 },
    ],
  },
  {
    key: "kpi", label: "KPIs", singular: "KPI update", prefix: "KPI", group: "Talent", routing: "manager", visibility: "private",
    description: "Report progress against a measurable goal. Your manager reviews it and approves or asks for changes.",
    initial: "SUBMITTED",
    statuses: [
      { key: "SUBMITTED", label: "Awaiting review", tone: "info" }, { key: "CHANGES_REQUESTED", label: "Changes requested", tone: "warning" },
      { key: "APPROVED", label: "Approved", tone: "success", terminal: true }, { key: "REJECTED", label: "Rejected", tone: "danger", terminal: true },
      { key: "WITHDRAWN", label: "Withdrawn", tone: "neutral", terminal: true },
    ],
    transitions: [
      approve(), reject(),
      { action: "request_changes", label: "Request changes", from: ["SUBMITTED"], to: "CHANGES_REQUESTED", by: ["approver"], noteRequired: true },
      { action: "resubmit", label: "Resubmit progress", from: ["CHANGES_REQUESTED"], to: "SUBMITTED", by: ["requester"], intent: "primary", fields: [
        { key: "actual", label: "Actual progress", type: "number", required: true },
      ] },
      cancel(["SUBMITTED", "CHANGES_REQUESTED"], "WITHDRAWN", "Withdraw update"),
    ],
    fields: [
      { key: "category", label: "Period", type: "text", column: "category", required: true, placeholder: "2026-Q3", max: 20 },
      { key: "title", label: "Goal title", type: "text", column: "title", required: true, max: 200 },
      { key: "metric", label: "Metric", type: "text", required: true, placeholder: "CSAT percentage", max: 120 },
      { key: "target", label: "Target", type: "number", required: true },
      { key: "actual", label: "Actual progress", type: "number", required: true },
      { key: "weight", label: "Weight %", type: "number", required: true, max: 100 },
      { key: "note", label: "Progress note", type: "textarea", required: true, max: 2000 },
    ],
  },
  {
    // DPDP Act 2023 ss.11–14 / DPDP Rules 2025: requests from employees (data principals) to their employer (data
    // fiduciary). The Rules cap the response time at 90 days; the SLA below is a 30-day internal target. Approved
    // erasure requests are carried out from My space → My data & privacy → Erasure requests (privacy module).
    key: "privacy_request", label: "Privacy requests", singular: "privacy request", prefix: "DPR", group: "Self service", routing: "hr", visibility: "private",
    description: "Ask for a copy, correction or erasure of your personal data, nominate someone to act for you, or raise a privacy grievance. HR / the grievance officer responds well within the 90 days the DPDP Rules allow.",
    initial: "SUBMITTED", slaHours: { LOW: 720, MEDIUM: 720, HIGH: 720, URGENT: 720 },
    statuses: [
      { key: "SUBMITTED", label: "Received", tone: "info" }, { key: "IN_REVIEW", label: "In review", tone: "warning" },
      { key: "AWAITING_INFO", label: "Waiting for your reply", tone: "warning" }, { key: "APPROVED", label: "Approved · erasure pending", tone: "warning" },
      { key: "COMPLETED", label: "Completed", tone: "success", terminal: true }, { key: "DECLINED", label: "Declined", tone: "danger", terminal: true },
      { key: "WITHDRAWN", label: "Withdrawn", tone: "neutral", terminal: true },
    ],
    transitions: [
      { action: "start_review", label: "Start review", from: ["SUBMITTED"], to: "IN_REVIEW", by: ["hr"], assignSelf: true, intent: "primary" },
      { action: "request_info", label: "Ask for details / identity check", from: ["IN_REVIEW"], to: "AWAITING_INFO", by: ["hr", "assignee"], noteRequired: true },
      { action: "provide_info", label: "Send reply", from: ["AWAITING_INFO"], to: "IN_REVIEW", by: ["requester"], noteRequired: true, intent: "primary" },
      { action: "approve_erasure", label: "Approve erasure", from: ["IN_REVIEW"], to: "APPROVED", by: ["hr"], intent: "primary" },
      { action: "complete", label: "Mark completed", from: ["IN_REVIEW", "APPROVED"], to: "COMPLETED", by: ["hr", "assignee"], noteRequired: true, intent: "primary" },
      { action: "decline", label: "Decline with reasons", from: ["IN_REVIEW", "APPROVED", "AWAITING_INFO"], to: "DECLINED", by: ["hr", "assignee"], noteRequired: true, intent: "danger" },
      cancel(["SUBMITTED", "IN_REVIEW", "AWAITING_INFO"], "WITHDRAWN", "Withdraw request"),
    ],
    fields: [
      { key: "category", label: "Type of request", type: "select", column: "category", required: true, options: ["Access", "Correction", "Erasure", "Grievance", "Nomination"],
        help: "Access: a copy is also available instantly via Download my data. Erasure applies to data not needed for your employment or required by law." },
      { key: "title", label: "Summary", type: "text", column: "title", required: true, placeholder: "e.g. My date of birth is wrong", max: 200 },
      { key: "details", label: "Details", type: "textarea", required: true, max: 4000, placeholder: "Which data, what is wrong or what you want removed, and why." },
      { key: "nomineeName", label: "Nominee name (nomination only)", type: "text", max: 120 },
      { key: "nomineeEmail", label: "Nominee email (nomination only)", type: "email", max: 160 },
    ],
  },
];

export const caseModuleMap = new Map(caseModules.map((module) => [module.key, module]));
