import { Body, Controller, Delete, Get, HttpCode, HttpException, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Public } from "../auth/public.decorator";
import { Roles } from "../auth/roles.decorator";
import { DevicesService } from "./devices.service";
import {
  CreateDeviceDto, CreateMappingDto, DevicePunchesQuery, IgnorePunchesDto, ImportMappingsDto, ResolveUnmatchedDto, UpdateDeviceDto, VersionDto,
} from "./integrations.dto";
import { INTEGRATION_ADMIN_ROLES } from "./shared";

/** HR administration of biometric devices, PIN mappings and the unmatched-punch queue. */
@ApiTags("integrations") @ApiBearerAuth() @Controller("api/v2/integrations/devices") @Roles(...INTEGRATION_ADMIN_ROLES)
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get() @ApiOperation({ summary: "Device registry with health (last seen, punches, unmatched)" })
  list(@Req() request: FastifyRequest) { return this.devices.list(request.identity!); }

  @Post() @ApiOperation({ summary: "Register a device; returns its secret and comm key once" })
  create(@Req() request: FastifyRequest, @Body() input: CreateDeviceDto) { return this.devices.create(request.identity!, input); }

  @Get("employees") employees(@Req() request: FastifyRequest) { return this.devices.employees(request.identity!); }

  @Get("mappings") mappings(@Req() request: FastifyRequest) { return this.devices.mappings(request.identity!); }
  @Post("mappings") createMapping(@Req() request: FastifyRequest, @Body() input: CreateMappingDto) { return this.devices.createMapping(request.identity!, input); }
  @Post("mappings/import") @HttpCode(200) @ApiOperation({ summary: "Bulk CSV import: employee_number,device_user_id[,device_serial]" })
  importMappings(@Req() request: FastifyRequest, @Body() input: ImportMappingsDto) { return this.devices.importMappings(request.identity!, input); }
  @Delete("mappings/:id") deleteMapping(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.devices.deleteMapping(request.identity!, id); }

  @Get("unmatched") unmatched(@Req() request: FastifyRequest) { return this.devices.unmatched(request.identity!); }
  @Post("unmatched/resolve") @HttpCode(200) @ApiOperation({ summary: "Map a device user ID to an employee and replay its queued punches" })
  resolve(@Req() request: FastifyRequest, @Body() input: ResolveUnmatchedDto) { return this.devices.resolveUnmatched(request.identity!, input); }
  @Post("unmatched/ignore") @HttpCode(200)
  ignore(@Req() request: FastifyRequest, @Body() input: IgnorePunchesDto) { return this.devices.ignorePunches(request.identity!, input.punchIds); }

  @Patch(":id") update(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: UpdateDeviceDto) { return this.devices.update(request.identity!, id, input); }
  @Post(":id/rotate") @HttpCode(200)
  rotate(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: VersionDto) { return this.devices.rotate(request.identity!, id, input.version); }
  @Post(":id/revoke") @HttpCode(200)
  revoke(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: VersionDto) { return this.devices.revoke(request.identity!, id, input.version); }
  @Get(":id/punches")
  punches(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Query() query: DevicePunchesQuery) { return this.devices.punches(request.identity!, id, query); }
}

/**
 * Signed JSON ingestion API for devices and middleware (e.g. an eSSL/Mantra bridge). Public to the user-auth guard;
 * authenticated by the device's HMAC signature instead. The body is validated only after the signature checks out.
 */
@ApiTags("integrations") @Controller("api/v2/integrations/devices")
export class DeviceIngestController {
  constructor(private readonly devices: DevicesService) {}

  @Public() @Post("punches") @HttpCode(200)
  @ApiOperation({ summary: "Device punches (≤500). Headers: x-device-serial, x-timestamp, x-signature = HMAC-SHA256(secret, `${timestamp}.${body}`)" })
  async punches(@Req() request: FastifyRequest) {
    const device = await this.devices.authenticateSigned(request.headers, request.integrationRawBody);
    const batch = await this.devices.parseSignedBatch(request.body);
    return this.devices.ingest(device, batch.punches.map((punch) => ({ ...punch, raw: { ...punch } })), "JSON", request.ip);
  }

  @Public() @Post("heartbeat") @HttpCode(200) @ApiOperation({ summary: "Signed device heartbeat (same headers as punches)" })
  async heartbeat(@Req() request: FastifyRequest) {
    const device = await this.devices.authenticateSigned(request.headers, request.integrationRawBody);
    const beat = await this.devices.parseHeartbeat(request.body);
    return this.devices.heartbeat(device, request.ip, "JSON", beat.firmware);
  }
}

type AdmsQuery = Record<string, string | undefined>;

/**
 * ZKTeco / eSSL ADMS ("push SDK") compatible endpoints. Devices are configured with this server's address and push
 * attendance logs as tab-separated text. Auth = serial number (SN) + the device's comm key (?key= or x-comm-key).
 * Responses are plain text, as the firmware expects.
 */
@ApiTags("integrations") @Controller("iclock")
export class AdmsController {
  constructor(private readonly devices: DevicesService) {}

  private key(request: FastifyRequest, query: AdmsQuery) {
    const header = request.headers["x-comm-key"];
    return query.key || query.CommKey || query.commkey || (Array.isArray(header) ? header[0] : header) || "";
  }
  private text(reply: FastifyReply, code: number, body: string) {
    return reply.code(code).header("content-type", "text/plain; charset=utf-8").header("cache-control", "no-store").send(body);
  }

  @Public() @Get(["cdata", "cdata.aspx"]) @ApiOperation({ summary: "ADMS handshake: returns device options" })
  async handshake(@Req() request: FastifyRequest, @Query() query: AdmsQuery, @Res() reply: FastifyReply) {
    const device = await this.devices.authenticateAdms(query.SN || "", this.key(request, query));
    if (!device) return this.text(reply, 401, "UNAUTHORIZED");
    await this.devices.heartbeat(device, request.ip, "ADMS", query.pushver ? `push ${query.pushver}` : undefined);
    return this.text(reply, 200, this.devices.admsOptions(device));
  }

  @Public() @Post(["cdata", "cdata.aspx"]) @ApiOperation({ summary: "ADMS upload: table=ATTLOG (tab-separated punches); other tables are acknowledged" })
  async upload(@Req() request: FastifyRequest, @Query() query: AdmsQuery, @Res() reply: FastifyReply) {
    const device = await this.devices.authenticateAdms(query.SN || "", this.key(request, query));
    if (!device) return this.text(reply, 401, "UNAUTHORIZED");
    const body = typeof request.body === "string" ? request.body : request.integrationRawBody?.toString("utf8") || "";
    if ((query.table || "").toUpperCase() !== "ATTLOG") {
      await this.devices.heartbeat(device, request.ip, "ADMS");
      return this.text(reply, 200, "OK");
    }
    try {
      const punches = this.devices.parseAttlog(body);
      if (punches.length) await this.devices.ingest(device, punches, "ADMS", request.ip);
      else await this.devices.heartbeat(device, request.ip, "ADMS");
      return this.text(reply, 200, "OK");
    } catch (error) {
      return this.text(reply, error instanceof HttpException ? error.getStatus() : 500, "ERROR");
    }
  }

  @Public() @Get(["getrequest", "getrequest.aspx"]) @ApiOperation({ summary: "ADMS command poll / heartbeat (no pending commands)" })
  async poll(@Req() request: FastifyRequest, @Query() query: AdmsQuery, @Res() reply: FastifyReply) {
    const device = await this.devices.authenticateAdms(query.SN || "", this.key(request, query));
    if (!device) return this.text(reply, 401, "UNAUTHORIZED");
    await this.devices.heartbeat(device, request.ip, "ADMS", query.INFO ? query.INFO.split(",")[0] : undefined);
    return this.text(reply, 200, "OK");
  }

  @Public() @Post(["devicecmd", "devicecmd.aspx"])
  async commandResult(@Req() request: FastifyRequest, @Query() query: AdmsQuery, @Res() reply: FastifyReply) {
    const device = await this.devices.authenticateAdms(query.SN || "", this.key(request, query));
    if (!device) return this.text(reply, 401, "UNAUTHORIZED");
    return this.text(reply, 200, "OK");
  }
}
