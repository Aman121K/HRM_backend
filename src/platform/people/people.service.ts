import { Injectable, NotFoundException } from "@nestjs/common";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";

@Injectable()
export class PeopleService {
  constructor(private readonly database: DatabaseService) {}
  me(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const result = await client.query(
        `SELECT id,employee_number AS "employeeNumber",full_name AS "fullName",work_email AS "workEmail",
                department,designation,location,manager_id AS "managerId",joining_date AS "joiningDate",status,version
           FROM employees WHERE organization_id=$1 AND id=$2`,
        [identity.organizationId, identity.employeeId],
      );
      if (!result.rowCount) throw new NotFoundException("Employee profile not found.");
      return result.rows[0];
    });
  }
  /** Employee register / directory, searchable and paged (limit ≤ 200, offset) with the total match count. */
  list(identity: AuthIdentity, search = "", limit = 50, offset = 0) {
    return this.database.tenantTransaction(identity, async (client) => {
      const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 50, 1), 200);
      const safeOffset = Math.max(Number.isFinite(offset) ? Math.floor(offset) : 0, 0);
      const filter = `e.organization_id=$1 AND ($2='' OR e.full_name ILIKE '%'||$2||'%' OR e.employee_number ILIKE '%'||$2||'%' OR e.work_email ILIKE '%'||$2||'%')`;
      const result = await client.query(
        `SELECT e.id,e.employee_number AS "employeeNumber",e.full_name AS "fullName",e.work_email AS "workEmail",
                e.department,e.designation,e.location,e.manager_id AS "managerId",m.full_name AS manager,
                to_char(e.joining_date,'YYYY-MM-DD') AS "joiningDate",e.status,e.version,e.updated_at AS "updatedAt"
           FROM employees e LEFT JOIN employees m ON m.id=e.manager_id AND m.organization_id=e.organization_id
          WHERE ${filter}
          ORDER BY e.status,e.full_name,e.id LIMIT $3 OFFSET $4`,
        [identity.organizationId, search.trim(), safeLimit, safeOffset],
      );
      // A separate count keeps the page query an index-ordered LIMIT instead of reading every row for a window count.
      const total = result.rows.length < safeLimit && safeOffset === 0 ? result.rows.length
        : (await client.query(`SELECT count(*)::int AS n FROM employees e WHERE ${filter}`, [identity.organizationId, search.trim()])).rows[0].n;
      return { items: result.rows, limit: safeLimit, offset: safeOffset, total };
    });
  }
}
