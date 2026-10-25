import { Body, Controller, Get, HttpCode, Post, Put, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { MarkReadDto, PreferencesDto, RegisterDeviceDto, UnregisterDeviceDto } from "./notifications.dto";
import { NotificationsService } from "./notifications.service";
import { PushService } from "./push.service";

// Registered in AppModule (historical); its services come from the global NotificationsModule.
@ApiTags("notifications") @ApiBearerAuth() @Controller("api/v2/notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService, private readonly push: PushService) {}

  @Get() @ApiOperation({ summary: "In-app notifications (newest 50 above ?after) with read flags and the unread count" })
  list(@Req() request: FastifyRequest, @Query("after") after = "0") {
    const cursor = Number.isSafeInteger(Number(after)) && Number(after) >= 0 ? Number(after) : 0;
    return this.notifications.list(request.identity!, cursor);
  }

  @Post("read") @HttpCode(200) @ApiOperation({ summary: "Mark notifications read: {ids:[…]} or {all:true}" })
  read(@Req() request: FastifyRequest, @Body() input: MarkReadDto) { return this.notifications.markRead(request.identity!, input); }

  @Post("devices") @HttpCode(200) @ApiOperation({ summary: "Register (upsert) this device's push token" })
  register(@Req() request: FastifyRequest, @Body() input: RegisterDeviceDto) { return this.notifications.registerDevice(request.identity!, input); }

  @Post("devices/unregister") @HttpCode(200) @ApiOperation({ summary: "Stop pushes to a token (sign-out)" })
  unregister(@Req() request: FastifyRequest, @Body() input: UnregisterDeviceDto) { return this.notifications.unregisterDevice(request.identity!, input); }

  @Get("devices") @ApiOperation({ summary: "The caller's registered devices (masked tokens)" })
  devices(@Req() request: FastifyRequest) { return this.notifications.devices(request.identity!); }

  @Get("preferences") preferences(@Req() request: FastifyRequest) { return this.notifications.preferences(request.identity!); }

  @Put("preferences") @ApiOperation({ summary: "Replace notification preferences (send version for optimistic concurrency)" })
  updatePreferences(@Req() request: FastifyRequest, @Body() input: PreferencesDto) { return this.notifications.updatePreferences(request.identity!, input); }

  @Post("test-push") @HttpCode(200) @ApiOperation({ summary: "Send a test push to all of the caller's devices; returns per-device results" })
  testPush(@Req() request: FastifyRequest) { return this.push.testPush(request.identity!); }
}
