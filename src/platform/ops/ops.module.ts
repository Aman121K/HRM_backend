import { Module } from "@nestjs/common";
import { OpsController } from "./ops.controller";
import { OpsService } from "./ops.service";

/** Platform operations status (super admins only). Registered in FEATURE_MODULES. */
@Module({ controllers: [OpsController], providers: [OpsService] })
export class OpsModule {}
