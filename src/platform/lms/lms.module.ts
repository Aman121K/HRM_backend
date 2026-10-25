import { Module } from "@nestjs/common";
import { LmsController } from "./lms.controller";
import { LmsService } from "./lms.service";

@Module({ controllers: [LmsController], providers: [LmsService] })
export class LmsModule {}
