import { Module } from "@nestjs/common";
import { PayrollModule } from "../payroll/payroll.module";
import { ImportsController } from "./imports.controller";
import { ImportsService } from "./imports.service";

/** Switch-over import: guided opening-data import (employee master, salary, leave, payroll YTD, old payslips) with undo. */
@Module({ imports: [PayrollModule], controllers: [ImportsController], providers: [ImportsService] })
export class ImportsModule {}
