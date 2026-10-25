import './lib/dev-only.mjs'; // refuses to run in production — see the file
// Seeds demo surveys and polls through the platform API so validation, audience snapshots, anonymity and
// notifications are exercised exactly as in the UI. Only dates are back-filled directly (the API refuses past dates).
// Usage: npm run db:seed:engagement            (requires the platform API on BACKEND_V2_PORT)
//        npm run db:seed:engagement -- --reset (removes the seeded surveys/polls first — local only)
import "dotenv/config";
import pg from "pg";

const api = `http://localhost:${process.env.BACKEND_V2_PORT || 4100}/api/v2/engagement`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const DAY = 86_400_000;

async function call(employee, path, body, method) {
  const response = await fetch(`${api}${path}`, {
    method: method || (body ? "POST" : "GET"),
    headers: { "content-type": "application/json", "x-tenant-id": "tenant-demo-001", "x-employee-id": employee },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${employee} ${path}: ${JSON.stringify(data.message)}`);
  return data;
}

const org = (await pool.query("SELECT id FROM organizations WHERE slug='blue-tokai'")).rows[0];
if (!org) throw new Error("Run npm run db:seed first — the demo organization is missing.");

async function tenant(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [org.id]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

const TITLES = {
  enps: "Q3 eNPS pulse",
  cafe: "Café experience survey",
  poll: "Which winter special should we launch in cafés?",
  pastPoll: "Best day for the monthly team cupping?",
  draft: "Indiranagar team check-in",
};

if (process.argv.includes("--reset")) {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to reset in production.");
  await tenant(async (client) => {
    const ids = (await client.query("SELECT id FROM surveys WHERE organization_id=$1 AND title = ANY($2)", [org.id, Object.values(TITLES)])).rows.map((row) => row.id);
    if (!ids.length) return;
    // Questions are locked outside DRAFT by a trigger, so return the seeded rows to DRAFT before removing them.
    await client.query("UPDATE surveys SET status='DRAFT' WHERE organization_id=$1 AND id = ANY($2)", [org.id, ids]);
    await client.query("DELETE FROM workflow_events WHERE organization_id=$1 AND entity_type='survey' AND entity_id = ANY($2)", [org.id, ids]);
    await client.query("DELETE FROM surveys WHERE organization_id=$1 AND id = ANY($2)", [org.id, ids]);
    console.log(`Removed ${ids.length} seeded surveys/polls.`);
  });
}

const existing = new Set((await tenant((client) => client.query("SELECT title FROM surveys WHERE organization_id=$1", [org.id]))).rows.map((row) => row.title));
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString();

// 1. A closed, anonymous eNPS pulse with 8 responses — enough to clear the 3-response threshold overall,
//    with Cafe Operations visible on its own and the small departments pooled into "Other groups".
if (!existing.has(TITLES.enps)) {
  const survey = await call("BT000", "/surveys", {
    title: TITLES.enps, description: "Five quick questions on how it feels to work at Blue Tokai right now. Fully anonymous — results only appear once at least 3 people answer.",
    anonymous: true, allowEdit: false, shareResults: true, audienceType: "ALL", audienceValues: [], closesAt: inDays(7),
    questions: [
      { type: "ENPS", prompt: "How likely are you to recommend Blue Tokai as a place to work to a friend?", required: true },
      { type: "RATING", prompt: "I have the tools and training I need to do my job well.", required: true },
      { type: "RATING", prompt: "My manager gives me regular, useful feedback.", required: true },
      { type: "SINGLE_CHOICE", prompt: "What would most improve your week?", required: true, options: ["Better shift planning", "More training", "Clearer communication", "Recognition", "Nothing — all good"] },
      { type: "LONG_TEXT", prompt: "What is one thing we should start, stop or keep doing?", required: false },
    ],
  });
  const launched = await call("BT000", `/surveys/${survey.id}/launch`, { version: survey.version });
  const full = await call("BT000", `/surveys/${survey.id}`);
  const [enps, tools, feedback, improve, open] = full.questions.map((question) => question.id);
  const answers = [
    ["BT002", 9, 4, 4, "Better shift planning", "Keep the Friday cupping sessions — they are the best part of the week."],
    ["BT003", 10, 5, 4, "Recognition", "Start sharing store-level NPS with the floor team every week."],
    ["BT004", 8, 3, 3, "More training", "More latte-art and brew-bar training for new baristas, please."],
    ["BT900", 6, 3, 2, "Better shift planning", "Rosters come out too late; publishing them two weeks ahead would help."],
    ["BT005", 9, 4, 5, "Nothing — all good", ""],
    ["BT006", 7, 4, 3, "Clearer communication", "Stop last-minute changes to the sourcing calendar."],
    ["BT007", 10, 5, 5, "Recognition", "Keep the kudos wall — people love it."],
    ["BT008", 5, 2, 3, "Clearer communication", "Start a monthly all-hands with Q&A from leadership."],
  ];
  for (const [employee, score, a, b, choice, text] of answers)
    await call(employee, `/surveys/${survey.id}/responses`, { answers: [
      { questionId: enps, value: score }, { questionId: tools, value: a }, { questionId: feedback, value: b },
      { questionId: improve, choices: [choice] }, ...(text ? [{ questionId: open, text }] : []),
    ] });
  const now = await call("BT000", `/surveys/${survey.id}`);
  await call("BT000", `/surveys/${survey.id}/close`, { version: now.version });
  // Back-date to a pulse that ran last month. Response days are spread over its window (day granularity only).
  await tenant(async (client) => {
    await client.query(`UPDATE surveys SET opens_at=now()-interval '40 days', launched_at=now()-interval '40 days', closes_at=now()-interval '26 days',
      closed_at=now()-interval '26 days', created_at=now()-interval '42 days' WHERE organization_id=$1 AND id=$2`, [org.id, survey.id]);
    await client.query(`UPDATE survey_invitations SET invited_at=now()-interval '40 days',
      responded_on = CASE WHEN responded_on IS NULL THEN NULL ELSE current_date - (27 + floor(random()*13))::int END WHERE organization_id=$1 AND survey_id=$2`, [org.id, survey.id]);
    await client.query(`UPDATE survey_responses SET submitted_on = current_date - (27 + floor(random()*13))::int WHERE organization_id=$1 AND survey_id=$2`, [org.id, survey.id]);
    await client.query(`UPDATE workflow_events SET created_at=now()-interval '40 days' WHERE organization_id=$1 AND entity_type='survey' AND entity_id=$2`, [org.id, survey.id]);
  });
  console.log(`Seeded closed eNPS pulse (${answers.length} responses, launched to ${launched.invited}).`);
}

// 2. A live café survey the demo employee (BT002) has not answered yet. Two colleagues have, so results are still
//    locked behind the anonymity threshold — one more response unlocks them.
if (!existing.has(TITLES.cafe)) {
  const survey = await call("BT000", "/surveys", {
    title: TITLES.cafe, description: "Tell us how the café floor feels — equipment, rosters, customers and the team. Takes about 3 minutes and is anonymous.",
    anonymous: true, allowEdit: false, shareResults: false, audienceType: "DEPARTMENTS", audienceValues: ["Cafe Operations", "Retail Operations"], closesAt: inDays(12),
    questions: [
      { type: "RATING", prompt: "Our espresso machines and grinders are reliable during rush hour.", required: true },
      { type: "RATING", prompt: "I get my roster early enough to plan my week.", required: true, scaleLabels: ["Never", "Rarely", "Sometimes", "Usually", "Always"] },
      { type: "RATING", prompt: "I feel supported by my shift supervisor.", required: true },
      { type: "SINGLE_CHOICE", prompt: "Which shift do you usually work?", required: true, options: ["Opening (6 am – 2 pm)", "Mid (10 am – 6 pm)", "Closing (2 pm – 10 pm)", "It varies"] },
      { type: "MULTI_CHOICE", prompt: "What slows you down most on a busy day?", helpText: "Pick all that apply.", required: false, options: ["Order queue", "Milk & stock runs", "Card machine", "Too few people on shift", "Training gaps"] },
      { type: "ENPS", prompt: "How likely are you to recommend working at a Blue Tokai café to a friend?", required: true },
      { type: "SHORT_TEXT", prompt: "In one line: what customers compliment most?", required: false },
      { type: "LONG_TEXT", prompt: "Anything else you'd like the café leadership team to hear?", required: false },
    ],
  });
  await call("BT000", `/surveys/${survey.id}/launch`, { version: survey.version });
  const full = await call("BT000", `/surveys/${survey.id}`);
  const q = full.questions.map((question) => question.id);
  const answers = [
    ["BT003", [4, 3, 5, "Opening (6 am – 2 pm)", ["Order queue", "Milk & stock runs"], 9, "The pour-over bar", "More hands on weekend mornings would help a lot."]],
    ["BT004", [3, 2, 4, "Closing (2 pm – 10 pm)", ["Too few people on shift"], 7, "Friendly baristas", ""]],
  ];
  for (const [employee, [machines, roster, support, shift, slow, enps, compliment, note]] of answers)
    await call(employee, `/surveys/${survey.id}/responses`, { answers: [
      { questionId: q[0], value: machines }, { questionId: q[1], value: roster }, { questionId: q[2], value: support },
      { questionId: q[3], choices: [shift] }, { questionId: q[4], choices: slow }, { questionId: q[5], value: enps },
      ...(compliment ? [{ questionId: q[6], text: compliment }] : []), ...(note ? [{ questionId: q[7], text: note }] : []),
    ] });
  await tenant((client) => client.query(`UPDATE surveys SET opens_at=now()-interval '2 days', launched_at=now()-interval '2 days' WHERE organization_id=$1 AND id=$2`, [org.id, survey.id]));
  console.log("Seeded live Café experience survey (2 of 6 responded).");
}

// 3. Polls: one active (company-wide), one closed last week.
if (!existing.has(TITLES.poll)) {
  const poll = await call("BT000", "/polls", {
    question: TITLES.poll, options: ["Spiced jaggery latte", "Hazelnut cold brew", "Filter kaapi tonic", "Dark chocolate mocha"],
    multiple: false, anonymous: true, audienceType: "ALL", audienceValues: [], closesAt: inDays(6),
  });
  for (const [employee, choice] of [["BT001", "Filter kaapi tonic"], ["BT003", "Spiced jaggery latte"], ["BT005", "Filter kaapi tonic"], ["BT007", "Hazelnut cold brew"], ["BT008", "Filter kaapi tonic"]])
    await call(employee, `/polls/${poll.id}/vote`, { choices: [choice] });
  console.log("Seeded active poll (5 votes).");
}
if (!existing.has(TITLES.pastPoll)) {
  const poll = await call("BT000", "/polls", {
    question: TITLES.pastPoll, options: ["Monday", "Wednesday", "Friday"], multiple: false, anonymous: true, audienceType: "ALL", audienceValues: [], closesAt: inDays(3),
  });
  for (const [employee, choice] of [["BT001", "Friday"], ["BT002", "Friday"], ["BT003", "Wednesday"], ["BT006", "Friday"], ["BT009", "Monday"], ["BT010", "Friday"]])
    await call(employee, `/polls/${poll.id}/vote`, { choices: [choice] });
  const closed = await call("BT000", `/polls/${poll.id}/close`, { version: poll.version });
  await tenant((client) => client.query(`UPDATE surveys SET opens_at=now()-interval '12 days', launched_at=now()-interval '12 days', closes_at=now()-interval '5 days',
    closed_at=now()-interval '5 days', created_at=now()-interval '12 days' WHERE organization_id=$1 AND id=$2`, [org.id, closed.id]));
  console.log("Seeded closed poll (6 votes).");
}

// 4. A manager's draft for their own direct reports (identified, editable responses).
if (!existing.has(TITLES.draft)) {
  await call("BT001", "/surveys", {
    title: TITLES.draft, description: "A short monthly check-in for my team. Not anonymous so I can follow up with you one-to-one.",
    anonymous: false, allowEdit: true, shareResults: false, audienceType: "TEAM", audienceValues: [],
    questions: [
      { type: "RATING", prompt: "How manageable was your workload this month?", required: true, scaleLabels: ["Overwhelming", "Heavy", "About right", "Light", "Very light"] },
      { type: "SINGLE_CHOICE", prompt: "Would you like a one-to-one this week?", required: true, options: ["Yes, please", "Maybe later", "Not needed"] },
      { type: "LONG_TEXT", prompt: "Anything blocking you that I can help with?", required: false },
    ],
  });
  console.log("Seeded manager draft survey.");
}

await pool.end();
console.log("Engagement seed complete.");
