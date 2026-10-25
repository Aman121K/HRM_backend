import { Global, Module } from "@nestjs/common";
import { AttendanceController } from "./attendance.controller";
import { AttendanceService } from "./attendance.service";
import { PunchGuard } from "./punch-guard";

/** Global so integrations (biometric devices) can record punches through the same rules. */
@Global()
@Module({ controllers: [AttendanceController], providers: [AttendanceService, PunchGuard], exports: [AttendanceService] })
export class AttendanceModule {}
