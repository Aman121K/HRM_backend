import { Module } from "@nestjs/common";
import { TaxController } from "./tax.controller";
import { TaxService } from "./tax.service";

/** Employee tax declarations + proofs + payroll review (/api/v2/payroll/tax). Replaces the legacy /api/v1/tax routes. */
@Module({ controllers: [TaxController], providers: [TaxService], exports: [TaxService] })
export class TaxModule {}
