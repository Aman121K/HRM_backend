import './lib/dev-only.mjs'; // refuses to run in production — see the file
// Seeds a multi-brand demo: a brand group, a Group Owner (platform admin), Blue Tokai branding, and two more brands
// (Got Tea, Suchali's) provisioned through the platform API with their own HR, managers and staff. Re-runnable.
// Usage: npm run db:seed:brands   (platform API must be running)
import "dotenv/config";
import pg from "pg";

const api = `http://localhost:${process.env.BACKEND_V2_PORT || 4100}/api/v2`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const OWNER_EMAIL = "group.owner@northstar.example";

async function call(slug, employee, method, path, body) {
  const response = await fetch(`${api}${path}`, {
    method, headers: { "content-type": "application/json", "x-tenant-id": slug, "x-employee-id": employee }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${JSON.stringify(data.message || data)}`);
  return data;
}
async function tenant(orgId, work) {
  const client = await pool.connect();
  try { await client.query("BEGIN"); await client.query("SELECT set_config('app.organization_id',$1,true)", [orgId]); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

// 1. Blue Tokai branding + the brand group
const blueTokai = (await pool.query(`SELECT id FROM organizations WHERE slug='blue-tokai'`)).rows[0];
if (!blueTokai) throw new Error("Run the core seed first — blue-tokai is missing.");
const group = (await pool.query(`INSERT INTO organization_groups(name,slug) VALUES('Brands Group','brands-group')
  ON CONFLICT (slug) DO UPDATE SET name=organization_groups.name RETURNING id`)).rows[0];
await pool.query(`UPDATE organizations SET display_name='Blue Tokai Coffee Roasters', short_name='Blue Tokai', legal_name=coalesce(legal_name,'Blue Tokai Coffee Roasters Pvt. Ltd.'),
  brand_color='#1c3f6e', accent_color='#e07b39', industry='Specialty coffee', employee_prefix='BT', default_state='KA', group_id=$2 WHERE id=$1`, [blueTokai.id, group.id]);

// 2. Group Owner: platform admin + group owner + OWNER in Blue Tokai (with an employee record so demo sign-in works)
const owner = (await pool.query(`INSERT INTO users(email,full_name) VALUES($1,'Group Owner') ON CONFLICT (email) DO UPDATE SET full_name=users.full_name RETURNING id`, [OWNER_EMAIL])).rows[0];
await pool.query(`INSERT INTO platform_admins(user_id) VALUES($1) ON CONFLICT DO NOTHING`, [owner.id]);
await pool.query(`INSERT INTO group_admins(group_id,user_id,role) VALUES($1,$2,'GROUP_OWNER') ON CONFLICT DO NOTHING`, [group.id, owner.id]);
await tenant(blueTokai.id, async (client) => {
  await client.query(`INSERT INTO organization_memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER') ON CONFLICT (organization_id,user_id) DO UPDATE SET role='OWNER', status='ACTIVE'`, [blueTokai.id, owner.id]);
  await client.query(`INSERT INTO employees(organization_id,user_id,employee_number,full_name,work_email,department,designation,joining_date)
    VALUES($1,$2,'BT-OWN','Group Owner',$3,'Leadership','Group Owner','2020-01-01') ON CONFLICT (organization_id,user_id) DO NOTHING`, [blueTokai.id, owner.id, OWNER_EMAIL]);
});

// 2b. A brand-less Super Admin who manages every brand from /admin (no employee record, no brand membership)
const superAdmin = (await pool.query(`INSERT INTO users(email,full_name) VALUES('superadmin@northstar.example','Super Admin') ON CONFLICT (email) DO UPDATE SET full_name=users.full_name RETURNING id`)).rows[0];
await pool.query(`INSERT INTO platform_admins(user_id) VALUES($1) ON CONFLICT DO NOTHING`, [superAdmin.id]);

// 3. New brands through the platform API (acting as the Group Owner in Blue Tokai)
const brands = [
  { slug: "got-tea", displayName: "Got Tea", legalName: "Got Tea Beverages Pvt. Ltd.", shortName: "Got Tea", brandColor: "#1f7a4a", accentColor: "#f2b705",
    industry: "Tea & bubble tea cafés", defaultState: "MH", employeePrefix: "GT", admin: { fullName: "Got Tea HR", workEmail: "hr@gottea.example", designation: "HR Manager" },
    manager: ["GT002", "Rahul Deshmukh", "Store Manager", "Mumbai — Bandra"], employee: ["GT003", "Pooja Nair", "Tea Barista", "Mumbai — Bandra"],
    staff: [["GT004", "Aman Verma", "Tea Barista", "Mumbai — Andheri"], ["GT005", "Sara Khan", "Shift Lead", "Pune — Koregaon Park"], ["GT006", "Nikhil Joshi", "Tea Barista", "Pune — Koregaon Park"]],
    site: ["Bandra outlet", 19.0596, 72.8295] },
  { slug: "suchalis", displayName: "Suchali's Artisan Bakehouse", legalName: "Suchali's Artisan Bakehouse Pvt. Ltd.", shortName: "Suchali's", brandColor: "#8e3b2a", accentColor: "#e8b04b",
    industry: "Artisan bakery", defaultState: "KA", employeePrefix: "SA", admin: { fullName: "Suchali's HR", workEmail: "hr@suchalis.example", designation: "HR Lead" },
    manager: ["SA002", "Meghna Rao", "Bakery Manager", "Bengaluru — Koramangala"], employee: ["SA003", "Joseph D'Souza", "Baker", "Bengaluru — Koramangala"],
    staff: [["SA004", "Lakshmi Iyer", "Pastry Chef", "Bengaluru — Koramangala"], ["SA005", "Irfan Ali", "Baker", "Bengaluru — Whitefield"], ["SA006", "Tanya Bose", "Store Associate", "Bengaluru — Whitefield"]],
    site: ["Koramangala bakehouse", 12.9352, 77.6245] },
];

for (const brand of brands) {
  let org = (await pool.query(`SELECT id FROM organizations WHERE slug=$1`, [brand.slug])).rows[0];
  if (!org) {
    const created = await call("blue-tokai", "BT-OWN", "POST", "/platform/orgs", {
      slug: brand.slug, displayName: brand.displayName, legalName: brand.legalName, shortName: brand.shortName, brandColor: brand.brandColor, accentColor: brand.accentColor,
      industry: brand.industry, defaultState: brand.defaultState, employeePrefix: brand.employeePrefix, groupId: group.id, admin: brand.admin, addMeAsOwner: true,
    });
    org = { id: created.id };
    console.log(`Provisioned ${brand.displayName}`);
  }
  await tenant(org.id, async (client) => {
    const hr = (await client.query(`SELECT id FROM employees WHERE organization_id=$1 AND employee_number=$2`, [org.id, `${brand.employeePrefix}001`])).rows[0];
    const person = async ([number, name, designation, location], role, managerId) => {
      const email = `${name.split(" ")[0].toLowerCase().replace(/[^a-z]/g, "")}@${brand.slug}.example`;
      let userId = null;
      if (role) {
        userId = (await client.query(`INSERT INTO users(email,full_name) VALUES($1,$2) ON CONFLICT (email) DO UPDATE SET full_name=users.full_name RETURNING id`, [email, name])).rows[0].id;
        await client.query(`INSERT INTO organization_memberships(organization_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [org.id, userId, role]);
      }
      return (await client.query(
        `INSERT INTO employees(organization_id,user_id,employee_number,full_name,work_email,department,designation,location,manager_id,joining_date)
         VALUES($1,$2,$3,$4,$5,'Store Operations',$6,$7,$8,'2024-06-01')
         ON CONFLICT (organization_id,employee_number) DO UPDATE SET manager_id=excluded.manager_id RETURNING id`,
        [org.id, userId, number, name, email, designation, location, managerId])).rows[0].id;
    };
    const managerId = await person(brand.manager, "MANAGER", hr?.id || null);
    await person(brand.employee, "EMPLOYEE", managerId);
    for (const staff of brand.staff) await person(staff, null, managerId);
    await client.query(`INSERT INTO attendance_sites(organization_id,name,latitude,longitude,radius_metres) VALUES($1,$2,$3,$4,150) ON CONFLICT (organization_id,name) DO NOTHING`,
      [org.id, ...brand.site]);
  });
  // A little real activity so each brand's screens aren't empty.
  const mine = await call(brand.slug, brand.employee[0], "GET", "/cases?module=helpdesk&scope=mine");
  if (!mine.items.length) {
    await call(brand.slug, brand.employee[0], "POST", "/cases", { module: "helpdesk", values: { category: "Payroll & tax", priority: "MEDIUM", title: "PF number not showing on my profile", description: "I joined in June and my UAN isn't visible yet." } });
    await call(brand.slug, brand.employee[0], "POST", "/cases", { module: "expenses", values: { category: "Local travel", title: "Auto to supplier for urgent stock", amount: 420, startDate: new Date().toISOString().slice(0, 10), merchant: "Rapido" } });
    await call(brand.slug, brand.manager[0], "POST", "/cases", { module: "recognition", values: { subjectEmployeeId: (await call(brand.slug, brand.manager[0], "GET", "/employees?search=" + encodeURIComponent(brand.employee[1]))).items[0].id,
      category: "Customer first", title: "Weekend rush handled with a smile", message: `${brand.employee[1].split(" ")[0]} kept the queue moving all Saturday.` } });
  }
}
console.log("Brands ready: Blue Tokai, Got Tea, Suchali's (group 'Brands Group'). Group Owner signs in as BT-OWN / GT000 / SA000.");
await pool.end();
