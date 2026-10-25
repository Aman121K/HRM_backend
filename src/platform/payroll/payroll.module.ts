import { Module } from "@nestjs/common";
import { PayrollController } from "./payroll.controller";
import { PayrollService } from "./payroll.service";
import { RunsService } from "./runs.service";

/** India payroll engine: salary structures, statutory rules (statutory.ts, tax-engine.ts), runs, payslips and exports. */
@Module({ controllers: [PayrollController], providers: [PayrollService, RunsService], exports: [PayrollService] })
export class PayrollModule {}
