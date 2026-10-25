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
  list(identity: AuthIdentity, search = "", limit = 50) {
    return this.database.tenantTransaction(identity, async (client) => {
      const safeLimit = Math.min(Math.max(limit, 1), 100);
      const result = await client.query(
        `SELECT e.id,e.employee_number AS "employeeNumber",e.full_name AS "fullName",e.work_email AS "workEmail",
                e.department,e.designation,e.location,e.manager_id AS "managerId",m.full_name AS manager,e.status,e.version,e.updated_at AS "updatedAt"
           FROM employees e LEFT JOIN employees m ON m.id=e.manager_id AND m.organization_id=e.organization_id
          WHERE e.organization_id=$1 AND ($2='' OR e.full_name ILIKE '%'||$2||'%' OR e.employee_number ILIKE '%'||$2||'%' OR e.work_email ILIKE '%'||$2||'%')
          ORDER BY e.status,e.full_name,e.id LIMIT $3`,
        [identity.organizationId, search.trim(), safeLimit],
      );
      return { items: result.rows, limit: safeLimit };
    });
  }
}
