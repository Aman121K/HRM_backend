import './lib/dev-only.mjs'; // refuses to run in production — see the file
// Seeds onboarding settings, the default checklist and demo joiners at different stages through the platform API,
// so validation, owner resolution, document rules, conversion and audit all run exactly as they do from the UI.
// Usage: npm run db:seed:onboarding   (requires the platform API on BACKEND_V2_PORT; safe to re-run)
import "dotenv/config";
import pg from "pg";

const api = `http://localhost:${process.env.BACKEND_V2_PORT || 4100}/api/v2`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function call(actor, path, body, method) {
  const response = await fetch(`${api}${path}`, {
    method: method || (body ? "POST" : "GET"),
    headers: { "content-type": "application/json", "x-tenant-id": "tenant-demo-001", "x-employee-id": actor },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${actor} ${method || (body ? "POST" : "GET")} ${path}: ${JSON.stringify(data.message)}`);
  return data;
}
const hr = (path, body, method) => call("BT000", path, body, method);

const org = (await pool.query("SELECT id FROM organizations WHERE slug='blue-tokai'")).rows[0];
if (!org) throw new Error("Run npm run db:seed first — the demo organization is missing.");
const people = Object.fromEntries((await pool.query("SELECT employee_number, id FROM employees WHERE organization_id=$1", [org.id])).rows.map((row) => [row.employee_number, row.id]));
for (const number of ["BT000", "BT001", "BT002", "BT003", "BT005", "BT008", "BT009"]) if (!people[number]) throw new Error(`Missing demo employee ${number}; run npm run db:seed:cases first.`);

// Dates relative to today in India.
const todayIst = new Date(Date.now() + 5.5 * 3600_000);
const day = (offset) => new Date(Date.UTC(todayIst.getUTCFullYear(), todayIst.getUTCMonth(), todayIst.getUTCDate() + offset)).toISOString().slice(0, 10);

// Tiny but valid files: a one-page PDF and a 1×1 PNG.
const pdf = (title) => Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${44 + title.length}>>stream
BT /F1 14 Tf 20 70 Td (${title}) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`).toString("base64");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const upload = (joiner, category, name) => hr("/files", {
  entityType: "onboarding_joiner", entityId: joiner.id, category, originalName: name,
  mimeType: category === "PHOTO" ? "image/png" : "application/pdf", base64: category === "PHOTO" ? png : pdf(`${name} (demo)`),
});

// 1. Settings: named owners for HR, IT and Finance tasks.
const settings = await hr("/onboarding/settings");
await hr("/onboarding/settings", {
  version: settings.version, hrOwnerId: people.BT000, itOwnerId: people.BT008, financeOwnerId: people.BT009,
  employeeNumberPrefix: "BT", workEmailDomain: "bluetokai.example",
  welcomeMessage: "Welcome to Blue Tokai! Your first cup is on us — we can't wait to brew great things together.",
}, "PUT");
const templates = await hr("/onboarding/templates");
console.log(`Settings saved · template “${templates.items[0].name}” with ${templates.items[0].taskCount} tasks`);

const exists = async (email) => (await pool.query("SELECT id FROM onboarding_joiners WHERE organization_id=$1 AND personal_email=$2", [org.id, email])).rowCount > 0;
const detail = (joiner) => hr(`/onboarding/joiners/${joiner.id}`);
async function task(joiner, match, action = "complete", note) {
  const current = await detail(joiner);
  const item = current.tasks.find((candidate) => candidate.title.startsWith(match) && candidate.status === "PENDING");
  if (!item) throw new Error(`No open task “${match}” for ${current.joiner.fullName}`);
  await hr(`/onboarding/tasks/${item.id}/actions`, { action, version: item.version, note });
}
async function verifyAll(joiner) {
  const current = await detail(joiner);
  for (const doc of current.documents.items) for (const file of doc.files) if (!file.reviewStatus)
    await hr(`/onboarding/documents/${file.id}/review`, { decision: "VERIFIED" });
}
async function uploadAll(joiner, first) {
  await upload(joiner, "PAN", `${first}-PAN.pdf`);
  await upload(joiner, "AADHAAR", `${first}-Aadhaar.pdf`);
  await upload(joiner, "BANK_PROOF", `${first}-cancelled-cheque.pdf`);
  await upload(joiner, "EDUCATION", `${first}-degree.pdf`);
  await upload(joiner, "PHOTO", `${first}-photo.png`);
}

// 2. Joining in 5 days — Cafe Operations, reporting to BT001. Paperwork verified; IT and Finance still preparing.
if (!(await exists("tanvi.deshpande@gmail.example"))) {
  const { joiner } = await hr("/onboarding/joiners", {
    fullName: "Tanvi Deshpande", personalEmail: "tanvi.deshpande@gmail.example", phone: "98860 44120",
    designation: "Barista", department: "Cafe Operations", location: "Bengaluru — Indiranagar",
    managerId: people.BT001, buddyId: people.BT003, joiningDate: day(5), employmentType: "FULL_TIME",
    notes: "Previously at a specialty café in Pune. Prefers morning shifts.",
  });
  await hr(`/onboarding/joiners/${joiner.id}`, { version: joiner.version, panNumber: "BQTPD4821K", aadhaarNumber: "4821 7730 5519" }, "PATCH");
  await uploadAll(joiner, "Tanvi");
  await verifyAll(joiner);
  await task(joiner, "Send welcome pack");
  console.log("Added Tanvi Deshpande — joins in 5 days, documents verified, IT/Finance prep open");
}

// 3. Pre-boarding with missing documents — PAN awaiting review, Aadhaar rejected, three not yet submitted.
if (!(await exists("kabir.malhotra@outlook.example"))) {
  const { joiner } = await hr("/onboarding/joiners", {
    fullName: "Kabir Malhotra", personalEmail: "kabir.malhotra@outlook.example", phone: "99100 23874",
    designation: "Roaster Trainee", department: "Roastery", location: "Bengaluru — Roastery",
    managerId: people.BT005, joiningDate: day(18), employmentType: "FULL_TIME",
  });
  await upload(joiner, "PAN", "Kabir-PAN.pdf");
  const aadhaar = await upload(joiner, "AADHAAR", "Kabir-Aadhaar-photo.pdf");
  await hr(`/onboarding/documents/${aadhaar.id}/review`, { decision: "REJECTED", reason: "Image is blurred — the number is not readable. Please upload a clearer scan." });
  await task(joiner, "Send welcome pack");
  console.log("Added Kabir Malhotra — pre-boarding, 1 document awaiting review, 1 rejected, 3 missing, no buddy yet");
}

// 4. Joined last week (6 days ago) — converted to an employee; first-week tasks in progress (manager check-in overdue).
if (!(await exists("isha.nair@gmail.example"))) {
  const { joiner } = await hr("/onboarding/joiners", {
    fullName: "Isha Nair", personalEmail: "isha.nair@gmail.example", phone: "97390 61205",
    designation: "Barista", department: "Cafe Operations", location: "Bengaluru — Indiranagar",
    managerId: people.BT001, buddyId: people.BT002, joiningDate: day(-6), employmentType: "FULL_TIME",
  });
  await hr(`/onboarding/joiners/${joiner.id}`, { version: joiner.version, panNumber: "CKNPN7314M", aadhaarNumber: "5307 9921 4468" }, "PATCH");
  await uploadAll(joiner, "Isha");
  await verifyAll(joiner);
  await task(joiner, "Send welcome pack");
  // Rohit (IT) has no HRMS login in the demo, so HR records the hand-off on his behalf.
  await task(joiner, "Prepare devices", "complete", "Logged for IT: tablet + POS login handed to the store manager.");
  await call("BT009", "/onboarding/my-tasks").then(async ({ items }) => {
    const item = items.find((candidate) => candidate.joiner.id === joiner.id && candidate.title.startsWith("Set up payroll"));
    await call("BT009", `/onboarding/tasks/${item.id}/actions`, { action: "complete", version: item.version, note: "Added to September payroll; old regime." });
  });
  let current = await detail(joiner);
  await hr(`/onboarding/joiners/${joiner.id}/transitions`, { action: "ready", version: current.joiner.version });
  current = await detail(joiner);
  const converted = await hr(`/onboarding/joiners/${joiner.id}/transitions`, { action: "convert", version: current.joiner.version });
  const buddyTask = converted.tasks.find((item) => item.title.startsWith("Welcome coffee"));
  await call("BT002", `/onboarding/tasks/${buddyTask.id}/actions`, { action: "complete", version: buddyTask.version, note: "Tour done, introduced to the morning crew." });
  console.log(`Added Isha Nair — joined ${day(-6)} as ${converted.joiner.employee.number}; first-week check-in and training open`);
}

// 5. Withdrawn — declined the offer after accepting.
if (!(await exists("arnav.sethi@yahoo.example"))) {
  const { joiner } = await hr("/onboarding/joiners", {
    fullName: "Arnav Sethi", personalEmail: "arnav.sethi@yahoo.example", designation: "Store Associate", department: "Retail Operations",
    location: "Mumbai — Bandra", managerId: people.BT010 || people.BT001, joiningDate: day(9), employmentType: "PART_TIME",
  });
  await hr(`/onboarding/joiners/${joiner.id}/transitions`, { action: "withdraw", version: joiner.version, note: "Accepted a counter-offer from current employer." });
  console.log("Added Arnav Sethi — withdrawn (counter-offer)");
}

// 6. A hired candidate waiting to be imported with “Start onboarding”.
const candidateEmail = "rhea.kapoor@example.com";
if (!(await pool.query("SELECT 1 FROM hr_cases WHERE organization_id=$1 AND module='candidates' AND details->>'email'=$2", [org.id, candidateEmail])).rowCount) {
  // Referred by Ananya (HR cannot move a case they raised themselves).
  let item = await call("BT001", "/cases", { module: "candidates", values: { title: "Rhea Kapoor", email: candidateEmail, phone: "98201 77310", position: "Cafe Manager — Pune", category: "Employee referral", experienceYears: 5 } });
  item = await hr(`/cases/${item.id}/transitions`, { action: "screen", version: item.version });
  item = await hr(`/cases/${item.id}/transitions`, { action: "interview", version: item.version, values: { interviewDate: day(-10), interviewer: "Ananya Sharma" } });
  item = await hr(`/cases/${item.id}/transitions`, { action: "offer", version: item.version, values: { amount: 720000 } });
  await hr(`/cases/${item.id}/transitions`, { action: "hire", version: item.version, values: { joiningDate: day(21) } });
  console.log("Added hired candidate Rhea Kapoor — ready for “Start onboarding”");
}

const summary = await hr("/onboarding/joiners");
console.log(`Onboarding pipeline: ${summary.counts.map((row) => `${row.status} ${row.count}`).join(" · ")}`);
await pool.end();
