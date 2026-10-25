import { Module } from "@nestjs/common";
import { AccessController } from "./access.controller";
import { AccessService } from "./access.service";

/** Role & permission administration: custom roles, assignments, access review and the audit log viewer. */
@Module({ controllers: [AccessController], providers: [AccessService], exports: [AccessService] })
export class AccessModule {}
