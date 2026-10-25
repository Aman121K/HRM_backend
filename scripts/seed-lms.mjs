import './lib/dev-only.mjs'; // refuses to run in production — see the file
// Seeds the learning catalogue through the platform API (authoring, publishing, mandatory enrolment,
// assignment, lesson progress and server-graded quizzes all run through the real rules), then adds
// progress for colleagues who have no login directly in SQL.
// Usage: npm run db:seed:lms        (requires the platform API on BACKEND_V2_PORT; re-runnable)
import "dotenv/config";
import pg from "pg";

const api = `http://localhost:${process.env.BACKEND_V2_PORT || 4100}/api/v2`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function call(employee, path, body, method) {
  const response = await fetch(`${api}${path}`, {
    method: method || (body ? "POST" : "GET"),
    headers: { ...(body ? { "content-type": "application/json" } : {}), "x-tenant-id": "tenant-demo-001", "x-employee-id": employee },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${employee} ${method || (body ? "POST" : "GET")} ${path}: ${response.status} ${JSON.stringify(data.message)}`);
  return data;
}
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const q = (prompt, options, correct, explanation, kind) => ({
  prompt, kind: kind || (correct.length > 1 ? "MULTI" : "SINGLE"),
  options: options.map((text, index) => ({ id: "abcdefgh"[index], text })), correct, explanation,
});

/** A small, valid one-page PDF so the PDF lesson has a real handout. */
function checklistPdf() {
  const lines = ["Blue Tokai - Daily bar cleaning checklist", "", "Opening: sanitise work surfaces, check fridge temps (below 5 C)",
    "Every 2 hours: wipe steam wands, change milk pitchers, empty knock box", "Closing: backflush group heads, soak portafilters, clean grinder hoppers",
    "Log every check in the FSSAI register and sign with your initials."];
  const text = lines.map((line, index) => `BT /F1 ${index ? 11 : 15} Tf 56 ${760 - index * 24} Td (${line.replace(/[()\\]/g, "")}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body).toString("base64");
}

const courses = [
  {
    author: "BT000",
    course: { title: "Espresso fundamentals", category: "Coffee craft", level: "BEGINNER", durationMinutes: 45, coverColor: "#6b3e26", coverEmoji: "☕",
      summary: "Pull a balanced, repeatable shot every time — from dose and grind to reading the extraction.",
      description: "Built with our roastery team for every new barista. You will learn the espresso recipe we use across Blue Tokai cafés, how to dial in when a new bag opens, and how to taste for under- and over-extraction." },
    lessons: [
      { title: "Anatomy of a great shot", type: "TEXT", durationMinutes: 8, body: "# What we are aiming for\nA Blue Tokai house shot is **18 g in, 36 g out, in 27–32 seconds**. That 1:2 ratio gives sweetness and body without bitterness.\n\n## The four variables\n- **Dose** — the dry coffee in the basket (18 g ± 0.2 g)\n- **Grind** — finer slows the flow, coarser speeds it up\n- **Yield** — the liquid espresso in the cup, weighed on the scale\n- **Time** — from pump start to pump stop\n\n## Tasting notes\nSour and thin usually means *under-extracted*: grind finer. Bitter and drying means *over-extracted*: grind coarser.\n\n> Change one variable at a time and write it down on the dial-in card." },
      { title: "Watch: dialling in on the bar", type: "VIDEO", durationMinutes: 12, videoUrl: "https://bluetokaicoffee.com/", body: "Watch the brew walkthrough, then practise with your shift supervisor. Replace this link with your internal training video (YouTube or Vimeo links embed automatically)." },
      { title: "Milk texture and latte basics", type: "TEXT", durationMinutes: 10, body: "## Steaming in three steps\n1. **Purge** the wand and start with cold milk in a cold pitcher.\n2. **Stretch** — keep the tip just below the surface until the pitcher feels warm (about 35 °C).\n3. **Roll** — sink the tip, spin the milk, and stop at 60–65 °C.\n\nGlossy, paint-like milk with no visible bubbles is the goal. Tap and swirl before you pour." },
      { title: "Espresso check", type: "QUIZ", durationMinutes: 8, passMark: 70, maxAttempts: 3, questions: [
        q("What is the Blue Tokai house espresso recipe?", ["18 g in, 36 g out, 27–32 s", "14 g in, 60 g out, 15 s", "22 g in, 22 g out, 45 s"], ["a"], "Our house ratio is 1:2 — 18 g of coffee yields 36 g of espresso."),
        q("A shot tastes sour and thin. What should you change first?", ["Grind finer", "Grind coarser", "Use hotter milk"], ["a"], "Sour and thin means under-extracted; a finer grind slows the flow and extracts more."),
        q("Which of these are espresso recipe variables? (select all)", ["Dose", "Yield", "Time", "Cup colour"], ["a", "b", "c"], "Dose, grind, yield and time are the four variables we control."),
      ] },
    ],
  },
  {
    author: "BT000",
    course: { title: "FSSAI food safety basics", category: "Food safety", level: "BEGINNER", durationMinutes: 35, coverColor: "#2f6f9f", coverEmoji: "🧼", mandatory: true, mandatoryDueDays: 21,
      summary: "Mandatory for every café and roastery colleague: hygiene, temperatures, allergens and the cleaning log.",
      description: "Covers the essentials of the Food Safety and Standards Act as they apply to our cafés, plus Blue Tokai's own opening and closing standards. You must pass the assessment (80%) to complete it." },
    lessons: [
      { title: "Why FSSAI matters at our cafés", type: "TEXT", durationMinutes: 6, body: "Every Blue Tokai café holds an **FSSAI licence** that must be displayed at the counter. Inspectors can visit without notice.\n\n## What the licence expects from you\n- Clean, sanitised surfaces and equipment\n- Correct storage temperatures\n- Honest labelling, including allergens\n- A cleaning and temperature log that is filled in *every day*" },
      { title: "Personal hygiene at the bar", type: "TEXT", durationMinutes: 7, body: "## Before every shift\n- Wash hands for **20 seconds** with soap, and again after breaks, handling cash or touching your face\n- Clean apron, hair tied back or covered, nails short\n- Report fever, vomiting or diarrhoea to your shift lead — do not work the bar\n\n## Allergens\nMilk, nuts, gluten and soy are the most common in our menu. Always use a **separate, cleaned pitcher** for plant milks." },
      { title: "Daily cleaning checklist", type: "PDF", durationMinutes: 5, body: "Download the checklist, keep a copy at the bar, and sign the FSSAI register at each check." },
      { title: "Food safety assessment", type: "QUIZ", durationMinutes: 12, passMark: 80, maxAttempts: 3, questions: [
        q("How long should you wash your hands?", ["5 seconds", "20 seconds", "Only when they look dirty"], ["b"], "Twenty seconds with soap removes most pathogens."),
        q("At what temperature should dairy be stored?", ["Below 5 °C", "Around 12 °C", "Room temperature"], ["a"], "Chilled food must be kept at or below 5 °C."),
        q("A colleague has been vomiting since last night. What should happen?", ["They work but wear gloves", "They report it and stay off the bar", "They work only the till"], ["b"], "Anyone with vomiting or diarrhoea must not handle food until 48 hours symptom-free."),
        q("Which of these belong in the daily log? (select all)", ["Fridge temperatures", "Cleaning checks", "Your playlist"], ["a", "b"], "Temperatures and cleaning checks are both recorded for inspectors."),
        q("Where must the FSSAI licence be displayed?", ["In the back office", "At the counter, visible to guests", "It does not need to be displayed"], ["b"], "The licence must be displayed prominently where customers can see it."),
      ] },
    ],
  },
  {
    author: "BT000",
    course: { title: "Handling guest complaints", category: "Customer service", level: "INTERMEDIATE", durationMinutes: 30, coverColor: "#d66555", coverEmoji: "💬",
      summary: "Turn an unhappy guest into a regular with the LAST method and a few calm, honest phrases.",
      description: "Practical scripts from our best store managers for the moments that matter: a wrong order, a long wait, or a guest who is simply having a bad day." },
    lessons: [
      { title: "The LAST method", type: "TEXT", durationMinutes: 8, body: "## Listen, Apologise, Solve, Thank\n1. **Listen** — let the guest finish. Nod, keep eye contact, don't interrupt.\n2. **Apologise** — sincerely, without blaming the kitchen or a colleague.\n3. **Solve** — offer a remake or a fix *before* they ask.\n4. **Thank** — thank them for telling you; most unhappy guests just leave.\n\n> A complaint handled well creates more loyalty than a visit where nothing went wrong." },
      { title: "Phrases that de-escalate", type: "TEXT", durationMinutes: 7, body: "## Say this\n- \"I'm sorry, that's not the experience we want for you.\"\n- \"Let me remake that for you right now.\"\n- \"Thank you for telling me — I'll share this with the team.\"\n\n## Avoid this\n- \"That's our policy.\"\n- \"It's not my fault.\"\n- \"Calm down.\"\n\nIf a guest becomes abusive, step back and call your shift lead. Your safety comes first." },
      { title: "Complaint handling check", type: "QUIZ", durationMinutes: 6, passMark: 70, maxAttempts: 0, questions: [
        q("What does the S in LAST stand for?", ["Smile", "Solve", "Stop"], ["b"], "Listen, Apologise, Solve, Thank."),
        q("A guest says their latte is cold. What is the best first response?", ["Explain the milk temperature policy", "Apologise and offer to remake it", "Ask them to wait for the manager"], ["b"], "Apologise and solve immediately — no policy talk."),
        q("Which phrases should you avoid? (select all)", ["\"That's our policy.\"", "\"Calm down.\"", "\"Let me remake that for you.\""], ["a", "b"], "Policy talk and 'calm down' escalate; offering a fix de-escalates."),
      ] },
    ],
  },
  {
    author: "BT000",
    course: { title: "First-time manager essentials", category: "Leadership", level: "INTERMEDIATE", durationMinutes: 50, coverColor: "#c78c2b", coverEmoji: "🧭",
      summary: "Your first 90 days leading a café team: one-to-ones, feedback, rosters and running a calm shift.",
      description: "For newly promoted shift supervisors and store managers. Short, practical lessons you can apply on your next shift." },
    lessons: [
      { title: "Your first 90 days", type: "TEXT", durationMinutes: 10, body: "## Days 1–30: listen\nMeet every team member one-to-one. Ask what helps them do great work and what gets in the way.\n\n## Days 31–60: set the rhythm\nFix the roster pattern, agree shift handover notes, and start a weekly 15-minute huddle.\n\n## Days 61–90: grow people\nPick one skill per person to develop, and book the training in Northstar." },
      { title: "Giving feedback that lands", type: "TEXT", durationMinutes: 10, body: "Use **SBI**: *Situation, Behaviour, Impact*.\n\n> \"During Saturday's rush (S), you jumped on the second grinder without being asked (B) — it cut the queue in half (I). Thank you.\"\n\nGive positive feedback often and in public; give corrective feedback soon and in private." },
      { title: "Running one-to-ones", type: "TEXT", durationMinutes: 10, body: "- Every two weeks, 20 minutes, same time\n- Their agenda first, yours second\n- End with one agreed action each\n- Write it down in the performance notes" },
      { title: "Manager check-in", type: "QUIZ", durationMinutes: 6, passMark: 50, maxAttempts: 0, questions: [
        q("What does SBI stand for?", ["Situation, Behaviour, Impact", "Start, Build, Improve", "Say, Believe, Inspire"], ["a"], "Situation, Behaviour, Impact keeps feedback specific and fair."),
        q("Where should corrective feedback be given?", ["In the team huddle", "Privately and soon", "In the annual review only"], ["b"], "Correct in private, soon after the event."),
      ] },
    ],
  },
  {
    author: "BT000",
    course: { title: "POSH awareness", category: "Compliance", level: "BEGINNER", durationMinutes: 25, coverColor: "#6a5acd", coverEmoji: "🛡️", mandatory: true, mandatoryDueDays: 30,
      summary: "Mandatory: the Prevention of Sexual Harassment Act, our Internal Committee, and how to raise a concern safely.",
      description: "Blue Tokai is committed to a workplace free from harassment. This course explains what the POSH Act covers, who sits on our Internal Committee and how complaints are handled confidentially." },
    lessons: [
      { title: "What counts as sexual harassment", type: "TEXT", durationMinutes: 8, body: "Under the **POSH Act, 2013**, sexual harassment includes any unwelcome:\n- physical contact or advances\n- demand or request for sexual favours\n- sexually coloured remarks or jokes\n- showing pornography\n- any other unwelcome physical, verbal or non-verbal conduct of a sexual nature\n\nIt applies at cafés, the roastery, offsite events and on work chat groups." },
      { title: "The Internal Committee and raising a complaint", type: "TEXT", durationMinutes: 8, body: "## Our Internal Committee (IC)\nThe IC is chaired by a senior woman employee and includes an external member. Contact details are in the Policies section of Northstar.\n\n## Raising a complaint\n1. Write to the IC within **three months** of the incident\n2. The IC may try conciliation *only if you ask for it*\n3. An inquiry is completed within **90 days**\n\nRetaliation against anyone who raises a concern is itself misconduct." },
      { title: "POSH assessment", type: "QUIZ", durationMinutes: 8, passMark: 75, maxAttempts: 3, questions: [
        q("Does the POSH Act apply on a work WhatsApp group?", ["Yes", "No, only in the office"], ["a"], "The workplace includes digital spaces used for work."),
        q("Within how long should a complaint normally be made?", ["One week", "Three months", "One year"], ["b"], "Complaints should be made within three months; the IC can extend this."),
        q("Who can ask for conciliation?", ["The respondent", "The complainant", "The store manager"], ["b"], "Conciliation happens only at the request of the aggrieved person."),
        q("Which of these can be sexual harassment? (select all)", ["Unwelcome jokes of a sexual nature", "Repeated requests for a date after a clear no", "Asking a colleague to cover a shift"], ["a", "b"], "Unwelcome sexual remarks and persistent advances are harassment."),
      ] },
    ],
  },
  {
    author: "BT001",
    course: { title: "Indiranagar opening & closing routine", category: "Operations", level: "BEGINNER", durationMinutes: 20, coverColor: "#0f8177", coverEmoji: "🗝️",
      summary: "The exact routine our Indiranagar team follows to open at 7:30 and close cleanly at 22:30.",
      description: "A team course from Ananya for the Indiranagar café. It covers the alarm, cash float, machine warm-up and end-of-day handover." },
    lessons: [
      { title: "Opening in 30 minutes", type: "TEXT", durationMinutes: 8, body: "1. Disarm the alarm and switch on the espresso machine first (it needs 25 minutes)\n2. Count the cash float — ₹5,000 — and log it\n3. Check fridge temperatures and the pastry delivery\n4. Dial in both grinders and taste a shot before the doors open" },
      { title: "Closing and handover", type: "TEXT", durationMinutes: 8, body: "- Backflush, soak and clean both groups\n- Count the till with a second colleague\n- Write the handover note in the shift log: stock, issues, guest feedback\n- Arm the alarm and lock the shutter" },
    ],
  },
];

const directory = new Map((await call("BT000", "/employees?limit=100")).items.map((person) => [person.employeeNumber, person.id]));
const existing = new Map((await call("BT000", "/lms/admin/courses")).items.map((course) => [course.title, course]));
const ids = {};

for (const spec of courses) {
  let course = existing.get(spec.course.title);
  if (!course) {
    course = await call(spec.author, "/lms/admin/courses", spec.course);
    for (const lesson of spec.lessons) {
      const { questions, ...rest } = lesson;
      course = await call(spec.author, `/lms/admin/courses/${course.id}/lessons`, { ...rest, questions, courseVersion: course.version });
      if (lesson.type === "PDF") {
        const added = course.lessons.find((item) => item.title === lesson.title);
        await call(spec.author, "/files", { entityType: "lms_lesson", entityId: added.id, originalName: "fssai-daily-cleaning-checklist.pdf", mimeType: "application/pdf", base64: checklistPdf() });
      }
    }
    course = await call(spec.author, `/lms/admin/courses/${course.id}/status`, { status: "PUBLISHED", version: course.version });
    console.log(`Published “${spec.course.title}”${course.mandatoryEnrolled ? ` — ${course.mandatoryEnrolled} mandatory enrolments` : ""}`);
  } else console.log(`Exists: “${spec.course.title}”`);
  ids[spec.course.title] = course.id;
}

// Learner journeys through the API (BT002 Ravi, BT001 Ananya)
async function learn(employee, title, { lessons = Infinity, pass = true } = {}) {
  const courseId = ids[title];
  const detail = await call(employee, `/lms/courses/${courseId}`);
  if (!detail.enrollment) await call(employee, `/lms/courses/${courseId}/enroll`, {});
  const outline = (await call(employee, `/lms/courses/${courseId}`)).lessons;
  const spec = courses.find((item) => item.course.title === title);
  for (const lesson of outline.slice(0, lessons)) {
    await call(employee, `/lms/courses/${courseId}/lessons/${lesson.id}/open`, {});
    if (lesson.completed) continue;
    if (lesson.type !== "QUIZ") { await call(employee, `/lms/courses/${courseId}/lessons/${lesson.id}/complete`, {}); continue; }
    const content = await call(employee, `/lms/courses/${courseId}/lessons/${lesson.id}`);
    if (content.quiz.passed || content.quiz.locked) continue;
    const key = spec.lessons.find((item) => item.title === lesson.title).questions;
    const answers = Object.fromEntries(content.questions.map((question, index) => [question.id, pass ? key[index].correct : [question.options.find((option) => !key[index].correct.includes(option.id)).id]]));
    const result = await call(employee, `/lms/courses/${courseId}/lessons/${lesson.id}/attempts`, { answers });
    console.log(`  ${employee} · ${title} · ${lesson.title}: ${result.score}% ${result.passed ? "passed" : "not passed"}`);
  }
}
await learn("BT002", "Espresso fundamentals");
await learn("BT002", "FSSAI food safety basics", { lessons: 2 });
await learn("BT001", "First-time manager essentials", { lessons: 2 });

// Manager assignments (direct reports only) and an HR department-wide assignment — first run only, so re-runs don't re-notify.
const firstRun = !existing.size;
const reports = ["BT002", "BT003", "BT004", "BT010"].map((number) => directory.get(number)).filter(Boolean);
if (firstRun) {
const assigned = await call("BT001", `/lms/admin/courses/${ids["Handling guest complaints"]}/assign`, { employeeIds: reports, dueDate: day(5), note: "Before the festive rush, please." });
console.log(`BT001 assigned “Handling guest complaints”: ${JSON.stringify(assigned)}`);
const team = await call("BT001", `/lms/admin/courses/${ids["Indiranagar opening & closing routine"]}/assign`, { employeeIds: reports.slice(0, 3), dueDate: day(10) });
console.log(`BT001 assigned the team routine: ${JSON.stringify(team)}`);
const roastery = await call("BT000", `/lms/admin/courses/${ids["Espresso fundamentals"]}/assign`, { department: "Retail Operations", dueDate: day(30) });
console.log(`HR assigned “Espresso fundamentals” to Retail Operations: ${JSON.stringify(roastery)}`);
}
await learn("BT002", "Handling guest complaints", { lessons: 1 });

// Colleagues without a login: progress written directly (same shape the API produces).
const org = (await pool.query("SELECT id FROM organizations WHERE slug='blue-tokai'")).rows[0];
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.organization_id',$1,true)", [org.id]);
  const enrollment = async (number, title) => (await client.query(
    `SELECT e.id, e.status FROM lms_enrollments e JOIN employees m ON m.id=e.employee_id WHERE e.organization_id=$1 AND m.employee_number=$2 AND e.course_id=$3`,
    [org.id, number, ids[title]])).rows[0];
  const lessonsOf = async (title) => (await client.query(`SELECT id, type FROM lms_lessons WHERE organization_id=$1 AND course_id=$2 AND deleted_at IS NULL ORDER BY position`, [org.id, ids[title]])).rows;
  async function progress(number, title, count, { complete = false, failedAttempt = false, daysAgo = 3 } = {}) {
    const row = await enrollment(number, title);
    if (!row || row.status === "COMPLETED") return;
    const lessons = await lessonsOf(title);
    const done = lessons.slice(0, count);
    for (const lesson of done) {
      await client.query(`INSERT INTO lms_lesson_progress(organization_id,enrollment_id,lesson_id,completed_at) VALUES($1,$2,$3,now() - make_interval(days => $4)) ON CONFLICT DO NOTHING`, [org.id, row.id, lesson.id, daysAgo]);
      if (lesson.type === "QUIZ") await client.query(`INSERT INTO lms_quiz_attempts(organization_id,enrollment_id,lesson_id,answers,score,passed,created_at) VALUES($1,$2,$3,'{}',$4,true,now() - make_interval(days => $5))`, [org.id, row.id, lesson.id, 100, daysAgo]);
    }
    if (failedAttempt) {
      const quiz = lessons.find((lesson) => lesson.type === "QUIZ");
      const already = (await client.query(`SELECT 1 FROM lms_quiz_attempts WHERE enrollment_id=$1`, [row.id])).rowCount;
      if (quiz && !already) await client.query(`INSERT INTO lms_quiz_attempts(organization_id,enrollment_id,lesson_id,answers,score,passed) VALUES($1,$2,$3,'{}',40,false)`, [org.id, row.id, quiz.id]);
    }
    const pct = Math.round((done.length / lessons.length) * 100);
    const finished = complete && done.length === lessons.length;
    await client.query(`UPDATE lms_enrollments SET progress_pct=$2, status=$3, started_at=coalesce(started_at, now() - make_interval(days => $4 + 2)), last_lesson_id=$5,
                          completed_at=CASE WHEN $3='COMPLETED' THEN now() - make_interval(days => $4) END, updated_at=now() WHERE id=$1`,
      [row.id, pct, finished ? "COMPLETED" : done.length ? "IN_PROGRESS" : "NOT_STARTED", daysAgo, done.at(-1)?.id || null]);
    if (finished) {
      const person = (await client.query(`SELECT e.employee_id, m.full_name, c.title, c.version FROM lms_enrollments e JOIN employees m ON m.id=e.employee_id JOIN lms_courses c ON c.id=e.course_id WHERE e.id=$1`, [row.id])).rows[0];
      const code = `NS-${Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[01IO]/g, "7")}-${Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[01IO]/g, "8")}`;
      await client.query(`INSERT INTO lms_certificates(organization_id,enrollment_id,course_id,employee_id,verification_code,course_title,employee_name,course_version,score,issued_at)
                          VALUES($1,$2,$3,$4,$5,$6,$7,$8,100,now() - make_interval(days => $9)) ON CONFLICT DO NOTHING`,
        [org.id, row.id, ids[title], person.employee_id, code, person.title, person.full_name, person.version, daysAgo]);
    }
  }
  await progress("BT003", "POSH awareness", 99, { complete: true, daysAgo: 12 });
  await progress("BT003", "FSSAI food safety basics", 99, { complete: true, daysAgo: 6 });
  await progress("BT003", "Handling guest complaints", 2, { daysAgo: 1 });
  await progress("BT004", "FSSAI food safety basics", 1, { failedAttempt: true, daysAgo: 20 });
  await progress("BT010", "Handling guest complaints", 1, { daysAgo: 2 });
  await progress("BT010", "POSH awareness", 99, { complete: true, daysAgo: 30 });
  // Demo only: make a few compliance enrolments overdue so the HR and manager views show real risk.
  await client.query(`UPDATE lms_enrollments e SET due_date=current_date - 4 FROM employees m
                        WHERE e.organization_id=$1 AND m.id=e.employee_id AND m.employee_number = ANY($2) AND e.course_id=$3 AND e.status<>'COMPLETED'`,
    [org.id, ["BT004", "BT900", "BT006"], ids["FSSAI food safety basics"]]);
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}

const reminders = await call("BT000", "/lms/admin/reminders", { withinDays: 7 });
console.log(`Reminders sent: ${JSON.stringify(reminders)}`);
const me = await call("BT002", "/lms/me");
console.log(`BT002 · ${JSON.stringify(me.stats)}`);
await pool.end();
