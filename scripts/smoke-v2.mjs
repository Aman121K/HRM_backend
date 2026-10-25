const base = process.env.BACKEND_V2_URL || "http://localhost:4100";
const request = async (path, headers = {}) => {
  const response = await fetch(`${base}${path}`, { headers });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
};

const health = await request("/api/v2/health");
if (health.database !== "postgresql") throw new Error("Health did not confirm PostgreSQL.");
const employeeHeaders = { "x-tenant-id": "tenant-demo-001", "x-employee-id": "BT002" };
const me = await request("/api/v2/me", employeeHeaders);
if (me.employeeNumber !== "BT002") throw new Error("Demo employee identity was not resolved.");
const directory = await request("/api/v2/employees?search=Ravi&limit=5", employeeHeaders);
if (!directory.items.some((item) => item.employeeNumber === "BT002"))
  throw new Error("Tenant directory did not include the current employee.");
const denied = await fetch(`${base}/api/v2/me`, {
  headers: { "x-tenant-id": "unknown-tenant", "x-employee-id": "BT002" },
});
if (denied.status !== 401) throw new Error(`Cross-tenant demo request returned ${denied.status}, expected 401.`);
console.log(JSON.stringify({ health: health.status, me: me.employeeNumber, directory: directory.items.length, crossTenant: denied.status }));
