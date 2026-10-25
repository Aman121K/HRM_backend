import { Global, Module } from "@nestjs/common";
import { FilesController } from "./files.controller";
import { FilesService } from "./files.service";

/** Global so any feature module can inject FilesService and register an access policy for its records. */
@Global()
@Module({ controllers: [FilesController], providers: [FilesService], exports: [FilesService] })
export class FilesModule {}
