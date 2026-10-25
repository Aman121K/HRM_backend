import { Body, Controller, Delete, Get, Header, Param, ParseUUIDPipe, Post, Query, Req, StreamableFile } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from "class-validator";
import type { FastifyRequest } from "fastify";
import { FilesService } from "./files.service";

export class UploadFileDto {
  @Matches(/^[a-z_]{2,40}$/) entityType!: string;
  @IsUUID() entityId!: string;
  @IsOptional() @Matches(/^[A-Za-z0-9_]{2,40}$/) category?: string;
  @IsString() @MaxLength(180) originalName!: string;
  @IsString() @MaxLength(60) mimeType!: string;
  @IsString() @MaxLength(12_000_000) base64!: string;
}
export class ListFilesQuery {
  @Matches(/^[a-z_]{2,40}$/) entityType!: string;
  @IsUUID() entityId!: string;
}

@ApiTags("files") @ApiBearerAuth() @Controller("api/v2/files")
export class FilesController {
  constructor(private readonly files: FilesService) {}
  @Get() list(@Req() request: FastifyRequest, @Query() query: ListFilesQuery) { return this.files.list(request.identity!, query.entityType, query.entityId); }
  @Post() upload(@Req() request: FastifyRequest, @Body() input: UploadFileDto) { return this.files.upload(request.identity!, input); }
  @Get(":id/content") @Header("x-content-type-options", "nosniff") @Header("cache-control", "private, no-store")
  async content(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) {
    const file = await this.files.download(request.identity!, id);
    return new StreamableFile(file.bytes, { type: file.mimeType, disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, length: file.bytes.length });
  }
  @Delete(":id") remove(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.files.remove(request.identity!, id); }
}
