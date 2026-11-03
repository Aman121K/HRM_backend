import './lib/dev-only.mjs'; // refuses to run in production — see the file
// Seeds demo colleagues and case-engine requests through the platform API so every
// workflow rule (routing, validation, transitions, audit) is exercised exactly as in the UI.
// Usage: npm run db:seed:cases            (requires the platform API on BACKEND_V2_PORT)
//        npm run db:seed:cases -- --reset (deletes existing demo cases first — local only)
import "dotenv/config";
import pg from "pg";

const api = `http://localhost:${process.env.BACKEND_V2_PORT || 4100}/api/v2`;
const people = { employee: "BT002", manager: "BT001", hr: "BT000" };
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function call(actor, path, body) {
  const response = await fetch(`${api}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", "x-tenant-id": "tenant-demo-001", "x-employee-id": people[actor] },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${actor} ${path}: ${JSON.stringify(data.message)}`);
  return data;
}
const create = (actor, module, values) => call(actor, "/cases", { module, values });
async function move(actor, item, action, extra = {}) {
  const updated = await call(actor, `/cases/${item.id}/transitions`, { action, version: item.version, ...extra });
  return updated;
}

const org = (await pool.query("SELECT id FROM organizations WHERE slug='blue-tokai'")).rows[0];
if (!org) throw new Error("Run npm run db:seed first — the demo organization is missing.");
const manager = (await pool.query("SELECT id FROM employees WHERE organization_id=$1 AND employee_number='BT001'", [org.id])).rows[0];

if (process.argv.includes("--reset")) {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to reset in production.");
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.organization_id',$1,true)", [org.id]);
  await client.query("DELETE FROM hr_case_events WHERE organization_id=$1", [org.id]);
  await client.query("DELETE FROM hr_cases WHERE organization_id=$1", [org.id]);
  await client.query("DELETE FROM hr_case_counters WHERE organization_id=$1", [org.id]);
  await client.query("COMMIT");
  client.release();
  console.log("Cleared existing demo cases.");
}

const colleagues = [
  ["BT003", "Priya Menon", "Cafe Operations", "Shift Supervisor", "Bengaluru — Indiranagar"],
  ["BT004", "Arjun Rao", "Cafe Operations", "Barista", "Bengaluru — Indiranagar"],
  ["BT005", "Sneha Kulkarni", "Roastery", "Roast Master", "Bengaluru — Roastery"],
  ["BT006", "Farhan Qureshi", "Supply Chain", "Green Coffee Buyer", "Chikmagalur"],
  ["BT007", "Kavya Iyer", "Marketing", "Brand Manager", "Bengaluru — HQ"],
  ["BT008", "Rohit Bansal", "Technology", "Platform Engineer", "Bengaluru — HQ"],
  ["BT009", "Neha Gupta", "Finance", "Accounts Executive", "Bengaluru — HQ"],
  ["BT010", "Imran Sheikh", "Retail Operations", "Store Manager", "Mumbai — Bandra"],
];
{
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.organization_id',$1,true)", [org.id]);
  for (const [number, name, department, designation, location] of colleagues)
    await client.query(
      `INSERT INTO employees(organization_id,employee_number,full_name,work_email,department,designation,location,manager_id,joining_date)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (organization_id,employee_number) DO NOTHING`,
      [org.id, number, name, `${name.split(" ")[0].toLowerCase()}@bluetokai.example`, department, designation, location,
        department.includes("Operations") ? manager.id : null, "2024-04-01"]);
  await client.query("COMMIT");
  client.release();
}
const directory = new Map((await call("employee", "/employees?limit=100")).items.map((person) => [person.employeeNumber, person.id]));
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

// Helpdesk
const payrollTicket = await create("employee", "helpdesk", { category: "Payroll & tax", priority: "HIGH", title: "September salary credited short by two days", description: "Pay for 14 and 15 September is missing, but attendance shows me present on both days." });
const itTicket = await create("employee", "helpdesk", { category: "IT & systems", priority: "MEDIUM", title: "POS login locked after password reset", description: "The café POS says my account is locked. I reset my password yesterday." });
let picked = await move("hr", itTicket, "pick_up");
picked = await move("hr", picked, "resolve", { note: "Unlocked your POS account and synced the new password. Please log in again." });
await create("manager", "helpdesk", { category: "Policies", priority: "LOW", title: "Clarify comp-off policy for festival weekends", description: "Team is asking whether Diwali weekend shifts earn comp-off or overtime." });

// Expenses
const lunch = await create("employee", "expenses", { category: "Meals", title: "Team lunch after inventory audit", amount: 2400, startDate: day(-6), merchant: "Third Wave Coffee" });
await create("employee", "expenses", { category: "Local travel", title: "Cab to Whitefield café for opening support", amount: 780, startDate: day(-3), merchant: "Uber" });
const fuel = await create("manager", "expenses", { category: "Fuel & mileage", title: "Store visits — Koramangala, HSR, JP Nagar", amount: 1860, startDate: day(-9), merchant: "Indian Oil" });
await move("hr", fuel, "approve").then((approved) => move("hr", approved, "pay", { values: { paymentReference: "UTR2026091800412" } }));
await move("manager", lunch, "send_back", { note: "Please attach the bill and list the attendees." });

// Travel
const trip = await create("employee", "travel", { title: "Hyderabad café launch — opening week support", fromCity: "Bengaluru", toCity: "Hyderabad", startDate: day(8), endDate: day(12), category: "Train", accommodation: "Company guest house", amount: 6400 });
await create("manager", "travel", { title: "Chikmagalur estate visit with sourcing team", fromCity: "Bengaluru", toCity: "Chikmagalur", startDate: day(15), endDate: day(17), category: "Self-drive", accommodation: "Hotel", amount: 14500 });
await move("manager", trip, "approve");

// Assets
const laptop = await create("manager", "assets", { category: "Laptop", title: "Laptop for area reporting and store audits", startDate: day(5), justification: "Current device is shared with the store; I need one for weekly P&L reviews." });
await move("hr", laptop, "approve").then((approved) => move("hr", approved, "allocate", { values: { assetTag: "BT-LAP-0142", serialNumber: "C02XK1ABJG5H" } }));
await create("employee", "assets", { category: "Uniform kit", title: "Replacement apron and two T-shirts", justification: "Current apron is torn near the pocket." });

// Learning
const course = await create("employee", "learning", { title: "SCA Barista Skills — Intermediate", category: "Coffee craft", provider: "Specialty Coffee Association", startDate: day(20), endDate: day(22), amount: 18500, description: "Improves milk texturing and calibration so I can train new joiners at our store." });
await move("manager", course, "approve");
await create("manager", "learning", { title: "First-time managers programme", category: "Leadership", provider: "ClanChief Academy", startDate: day(30), description: "Structured coaching and feedback practice for my five store managers." });

// Shifts
await create("employee", "shifts", { category: "Closing · 15:00–23:00", startDate: day(3), endDate: day(4), subjectEmployeeId: directory.get("BT004"), title: "College exam on Thursday morning — swapping with Arjun" });

// Letters
const letter = await create("employee", "letters", { category: "Salary certificate", title: "HDFC Bank, Indiranagar branch", purpose: "Two-wheeler loan application", deliveryMode: "Digital (signed PDF)" });
await move("hr", letter, "pick_up").then((started) => move("hr", started, "issue", { values: { letterReference: "BT/HR/2026/0931" } }));
await create("manager", "letters", { category: "Employment verification", title: "Visa application — Embassy of Japan", purpose: "Tourist visa for December", deliveryMode: "Printed copy" });

// Recognition
await create("manager", "recognition", { subjectEmployeeId: directory.get("BT002"), category: "Customer first", title: "Turned a complaint into a regular", message: "Ravi remade a pour-over three times until a guest loved it — she’s been back every morning since." });
await create("employee", "recognition", { subjectEmployeeId: directory.get("BT003"), category: "Team player", title: "Covered the Saturday rush single-handed", message: "Priya jumped behind the bar when two of us were stuck in traffic and kept the queue under five minutes." });
await create("hr", "recognition", { subjectEmployeeId: directory.get("BT005"), category: "Craft & quality", title: "New Attikan Estate roast profile", message: "Sneha’s new profile scored 87 at cupping. Thank you for the late nights at the roastery!" });
await create("manager", "recognition", { subjectEmployeeId: directory.get("BT010"), category: "Ownership", title: "Bandra store hit 100% audit score", message: "Imran’s team cleared every item on the food-safety audit for the second month running." });

// Recruitment
const cafeManager = await create("manager", "requisitions", { title: "Café Manager", category: "Cafe Operations", location: "Hyderabad — Jubilee Hills", openings: 1, employmentType: "Full-time", amount: 720000, description: "Lead our new Jubilee Hills café: team of 12, daily operations, P&L and guest experience." });
await move("hr", cafeManager, "approve");
const baristas = await create("manager", "requisitions", { title: "Barista", category: "Cafe Operations", location: "Bengaluru — multiple cafés", openings: 6, employmentType: "Full-time", amount: 300000, description: "Craft great coffee, welcome guests and keep the bar spotless. Training provided — passion required." });
await move("hr", baristas, "approve");
const roaster = await create("hr", "requisitions", { title: "Assistant Roaster", category: "Roastery", location: "Bengaluru — Roastery", openings: 1, employmentType: "Full-time", amount: 420000, description: "Support roast planning, QC cupping and green coffee inventory at our roastery." });
await create("manager", "requisitions", { title: "Weekend Barista (part-time)", category: "Cafe Operations", location: "Mumbai — Bandra", openings: 2, employmentType: "Part-time", amount: 180000, description: "Saturday and Sunday shifts at our Bandra café." });
void roaster;
const referral = await create("employee", "candidates", { title: "Aditi Joshi", email: "aditi.joshi@example.com", phone: "98450 11223", position: "Barista — Bengaluru", category: "Employee referral", experienceYears: 2, notes: "Worked with me at a previous café. Great latte art." });
await move("hr", referral, "screen").then((screened) => move("hr", screened, "interview", { values: { interviewDate: day(2), interviewer: "Priya Menon" } }));
await create("hr", "candidates", { title: "Karan Mehta", email: "karan.m@example.com", position: "Café Manager — Hyderabad", category: "Job portal", experienceYears: 6 });

// Exit
await create("manager", "exit", { category: "Relocation", endDate: day(45), title: "Relocating to Pune with family", message: "Thank you for a wonderful three years. I’m happy to support hiring and handover." }).catch((error) => console.warn(error.message));

void payrollTicket;
console.log("Seeded demo colleagues and requests across 11 case modules.");
await pool.end();
