import './lib/dev-only.mjs'; // refuses to run in production — see the file
// Generates realistic volume for scale / load testing in ONE dedicated test brand (default: load-test). Local only.
//
//   node scripts/seed-load-test.mjs [--slug=load-test] [--days=30] [--skip-attendance] [--skip-api]
//
// Prerequisites: the brand exists (POST /api/v2/platform/orgs) and its employees were bulk-imported
// (POST /api/v2/employees/import/commit). Then this script adds:
//   - attendance_events: one IN/OUT pair per employee per working day for the last --days days (direct SQL — the punch
//     API only accepts a live, current location, so history can't be back-dated through it); ~2 % land in the review queue;
//   - leave_balance_ledger: an OPENING balance per employee and leave type (direct SQL);
//   - leave requests (one per employee, half approved by the manager) and helpdesk / expense cases, through the platform
//     API (BACKEND_V2_PORT) with demo identity headers, so routing, notifications and audit run exactly as in the UI.
// Re-running is safe: attendance rows use deterministic idempotency keys, balances use ON CONFLICT, and the API part
// skips employees who already have a leave request. Remove everything by deleting the brand's rows (see the report).
import "dotenv/config";
import pg from "pg";

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const slug = arg("slug", "load-test");
const days = Number(arg("days", "30"));
const api = `http://localhost:${process.env.BACKEND_V2_PORT || 4100}/api/v2`;
if (!/^load-test/.test(slug)) throw new Error("This generator only writes into a brand whose slug starts with load-test.");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const org = (await pool.query(`SELECT id FROM organizations WHERE slug=$1`, [slug])).rows[0];
if (!org) throw new Error(`Brand ${slug} not found — create it and import employees first.`);
const tenant = async (work) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.organization_id',$1,true)", [org.id]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
};

if (!process.argv.includes("--skip-attendance")) {
  const started = Date.now();
  const inserted = await tenant(async (client) => (await client.query(
    `WITH days AS (
       SELECT d::date AS day FROM generate_series((now() AT TIME ZONE 'Asia/Kolkata')::date - $2::int, (now() AT TIME ZONE 'Asia/Kolkata')::date, interval '1 day') d
        WHERE extract(isodow FROM d) < 7),
     present AS (
       SELECT e.id AS employee_id, d.day, abs(hashtext(e.id::text || d.day::text)) AS h
         FROM employees e CROSS JOIN days d
        WHERE e.organization_id=$1 AND e.status='ACTIVE' AND abs(hashtext(e.id::text || d.day::text)) % 100 >= 6),
     punches AS (
       SELECT employee_id, day, h, 'IN' AS event_type, (day + time '08:45' + (h % 90) * interval '1 minute') AT TIME ZONE 'Asia/Kolkata' AS at FROM present
       UNION ALL
       SELECT employee_id, day, h, 'OUT', (day + time '17:30' + (h % 120) * interval '1 minute') AT TIME ZONE 'Asia/Kolkata' FROM present
        WHERE day < (now() AT TIME ZONE 'Asia/Kolkata')::date)
     INSERT INTO attendance_events(organization_id,employee_id,event_type,occurred_at,latitude,longitude,accuracy_metres,location_captured_at,timezone,
                                   device_id,permission,idempotency_key,created_at,source,within_geofence,review_status,review_reasons)
     SELECT $1, employee_id, event_type, at, 12.9716 + (h % 100) / 10000.0, 77.5946 + (h % 77) / 10000.0, 12 + h % 30, at, 'Asia/Kolkata',
            'load-test', 'granted', 'load-test:' || day || ':' || event_type, at, CASE WHEN h % 3 = 0 THEN 'MOBILE' ELSE 'WEB' END,
            h % 50 <> 0, CASE WHEN h % 50 = 0 THEN 'PENDING' ELSE 'NONE' END, CASE WHEN h % 50 = 0 THEN ARRAY['outside_geofence'] ELSE '{}'::text[] END
       FROM punches WHERE at <= now()
     ON CONFLICT (organization_id,employee_id,idempotency_key) DO NOTHING`, [org.id, days])).rowCount);
  const opening = await tenant(async (client) => (await client.query(
    `INSERT INTO leave_balance_ledger(organization_id,employee_id,leave_type_id,entry_type,days,as_of,note,created_by)
     SELECT $1, e.id, t.id, 'OPENING', least(t.annual_quota, 6 + abs(hashtext(e.id::text || t.code)) % 10), date_trunc('year', now())::date, 'load-test opening',
            (SELECT id FROM employees WHERE organization_id=$1 ORDER BY employee_number LIMIT 1)
       FROM employees e CROSS JOIN leave_types t
      WHERE e.organization_id=$1 AND t.organization_id=$1 AND t.active AND e.status='ACTIVE'
     ON CONFLICT DO NOTHING`, [org.id])).rowCount);
  console.log(`attendance: ${inserted} punches, ${opening} opening balances (${Date.now() - started} ms)`);
}

if (!process.argv.includes("--skip-api")) {
  const call = async (who, path, body) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetch(`${api}${path}`, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
        headers: { "content-type": "application/json", "x-tenant-id": slug, "x-employee-id": who } });
      if (response.status === 429) { await new Promise((r) => setTimeout(r, 2000)); continue; }
      const data = await response.json();
      if (!response.ok) throw new Error(`${who} ${path}: ${response.status} ${JSON.stringify(data.message)}`);
      return data;
    }
    throw new Error(`${who} ${path}: still rate limited`);
  };
  // Throttled worker pool: stays under the per-IP edge limit (RATE_LIMIT_IP_CEILING, default 6000/min).
  const runAll = async (items, work, concurrency = 8) => {
    let next = 0, done = 0, failed = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < items.length) {
        const item = items[next++];
        try { await work(item); done++; } catch (error) { failed++; if (failed < 5) console.warn(String(error.message).slice(0, 200)); }
        await new Promise((r) => setTimeout(r, 60));
      }
    }));
    return { done, failed };
  };
  const people = (await tenant((client) => client.query(
    `SELECT e.employee_number, e.manager_id IS NOT NULL AS has_manager, m.employee_number AS manager_number,
            EXISTS (SELECT 1 FROM leave_requests l WHERE l.organization_id=e.organization_id AND l.employee_id=e.id) AS has_leave
       FROM employees e LEFT JOIN employees m ON m.id=e.manager_id AND m.organization_id=e.organization_id
      WHERE e.organization_id=$1 AND e.status='ACTIVE' AND e.employee_number ~ '^[A-Z]+[0-9]{4}$' ORDER BY e.employee_number`, [org.id]))).rows;
  const types = (await call(people[0].employee_number, "/leave-types")).items;
  const casual = types.find((t) => /casual/i.test(t.name)) || types[0];
  const iso = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  let started = Date.now();
  const leaves = await runAll(people.filter((p) => p.has_manager && !p.has_leave), async (p) => {
    const offset = 7 + (Number(p.employee_number.replace(/^[A-Z]+/, "")) % 50);
    const created = await call(p.employee_number, "/leaves", { leaveTypeId: casual.id, startDate: iso(offset), endDate: iso(offset + 1), days: 2, reason: "Family function (load test)" });
    if (Number(p.employee_number.replace(/^[A-Z]+/, "")) % 2 === 0) await call(p.manager_number, `/approvals/leaves/${created.id}/decision`, { decision: "APPROVED", note: "ok" });
  });
  console.log(`leave: ${JSON.stringify(leaves)} (${Date.now() - started} ms)`);
  started = Date.now();
  const existingCases = Number((await tenant((client) => client.query(`SELECT count(*) AS n FROM hr_cases WHERE organization_id=$1`, [org.id]))).rows[0].n);
  const casePeople = existingCases ? [] : people.filter((_, index) => index % 2 === 0);
  const cases = await runAll(casePeople, async (p) => {
    const n = Number(p.employee_number.replace(/^[A-Z]+/, ""));
    if (n % 4 === 0) await call(p.employee_number, "/cases", { module: "expenses", values: { category: "Local travel", title: `Cab to store visit ${n}`, amount: 300 + (n % 900), startDate: iso(-(n % 20) - 1), merchant: "Uber" } });
    else await call(p.employee_number, "/cases", { module: "helpdesk", values: { category: "IT & systems", priority: "MEDIUM", title: `Laptop issue ${n}`, description: "Laptop is slow after the last update; please help (load test)." } });
  });
  console.log(`cases: ${JSON.stringify(cases)} (${Date.now() - started} ms)`);
}
await pool.end();
