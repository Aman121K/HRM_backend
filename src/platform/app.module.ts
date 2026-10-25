import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthGuard } from "./auth/auth.guard";
import { RolesGuard } from "./auth/roles.guard";
import { CoreModule } from "./core/core.module";
import { AuthController } from "./auth/auth.controller";
import { HealthController } from "./health/health.controller";
import { PeopleController } from "./people/people.controller";
import { PeopleService } from "./people/people.service";
import { LeaveController } from "./leave/leave.controller";
import { LeaveService } from "./leave/leave.service";
import { NotificationsController } from "./notifications/notifications.controller";
import { CasesModule } from "./cases/cases.module";
import { FEATURE_MODULES } from "./feature-modules";
import { OrganizationsModule } from "./organizations/organizations.module";
import { ModuleGuard } from "./organizations/module.guard";

@Module({
  imports: [CoreModule, OrganizationsModule, CasesModule, ...FEATURE_MODULES],
  controllers: [AuthController, HealthController, PeopleController, LeaveController, NotificationsController],
  providers: [
    PeopleService,
    LeaveService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ModuleGuard },
  ],
})
export class AppModule {}
