import { Module } from "@nestjs/common";
import { ReturnsController } from "./returns.controller";
import { ReturnsService } from "./returns.service";

/** Statutory returns: TDS challans, quarterly Form 138 / 24Q, annual Form 130 / 16 + perquisites and employee tax documents. */
@Module({ controllers: [ReturnsController], providers: [ReturnsService] })
export class PayrollReturnsModule {}
