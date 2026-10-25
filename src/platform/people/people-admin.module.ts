import { Module } from "@nestjs/common";
import { PeopleAdminController } from "./people-admin.controller";
import { PeopleAdminService } from "./people-admin.service";

/** Employee register administration: record edits and guided CSV import (HR / owner only). */
@Module({ controllers: [PeopleAdminController], providers: [PeopleAdminService] })
export class PeopleAdminModule {}
