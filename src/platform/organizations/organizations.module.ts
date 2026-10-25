import { Global, Module } from "@nestjs/common";
import { ModuleGuard } from "./module.guard";
import { OrganizationsController } from "./organizations.controller";
import { OrganizationsService } from "./organizations.service";

@Global()
@Module({ controllers: [OrganizationsController], providers: [OrganizationsService, ModuleGuard], exports: [OrganizationsService, ModuleGuard] })
export class OrganizationsModule {}
