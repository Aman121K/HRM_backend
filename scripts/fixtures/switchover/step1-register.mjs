import { csv, hr, log } from "./lib.mjs";
let r = await hr("POST", "/employees/import/dry-run", { csv: csv("00-register.csv"), fileName: "00-register.csv" });
log("register dry-run", r, (j) => j.summary || j);
if (r.j.summary?.invalid === 0 && r.j.rows.some((x) => x.outcome === "CREATE")) { r = await hr("POST", "/employees/import/commit", { csv: csv("00-register.csv"), fileName: "00-register.csv" }); log("register commit", r); }
