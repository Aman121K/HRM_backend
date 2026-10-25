import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { Public } from "../auth/public.decorator";
import { RuntimeConfig } from "../config/runtime-config";
import { AddAdminDto, CreateGroupDto, CreateOrganizationDto, DemoIdentitiesQuery, GroupQuery, PlatformUpdateOrganizationDto, UpdateBrandingDto } from "./organizations.dto";
import { OrganizationsService } from "./organizations.service";

@ApiTags("organizations") @ApiBearerAuth() @Controller("api/v2")
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService, private readonly config: RuntimeConfig) {}

  @Get("orgs/mine") mine(@Req() request: FastifyRequest) { return this.orgs.mine(request.identity!); }
  @Get("orgs/current") current(@Req() request: FastifyRequest) { return this.orgs.current(request.identity!); }
  @Patch("orgs/current") update(@Req() request: FastifyRequest, @Body() input: UpdateBrandingDto) { return this.orgs.updateBranding(request.identity!, input); }

  @Get("platform/orgs") platformList(@Req() request: FastifyRequest) { return this.orgs.platformList(request.identity!); }
  @Post("platform/orgs") create(@Req() request: FastifyRequest, @Body() input: CreateOrganizationDto) { return this.orgs.createOrganization(request.identity!, input); }
  @Patch("platform/orgs/:id") platformUpdate(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: PlatformUpdateOrganizationDto) {
    return this.orgs.platformUpdate(request.identity!, id, input);
  }
  @Get("platform/me") platformMe(@Req() request: FastifyRequest) { return this.orgs.platformMe(request.identity!); }
  @Get("platform/orgs/:id/admins") admins(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.orgs.brandAdmins(request.identity!, id); }
  @Post("platform/orgs/:id/admins") addAdmin(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: AddAdminDto) {
    return this.orgs.addBrandAdmin(request.identity!, id, input);
  }
  @Post("platform/groups") createGroup(@Req() request: FastifyRequest, @Body() input: CreateGroupDto) { return this.orgs.createGroup(request.identity!, input); }

  @Get("group/overview") group(@Req() request: FastifyRequest, @Query() query: GroupQuery) { return this.orgs.groupOverview(request.identity!, query.groupId); }

  /** Local demo only: brands and the seeded people you can sign in as. */
  @Get("auth/demo-identities") @Public()
  demo(@Query() query: DemoIdentitiesQuery) {
    if (this.config.nodeEnv === "production" || !this.config.allowDemoIdentity) return { organizations: [] };
    return this.orgs.demoIdentities(query.slug);
  }

  @Get("auth/demo-platform-admins") @Public()
  demoPlatformAdmins() {
    if (this.config.nodeEnv === "production" || !this.config.allowDemoIdentity) return { items: [] };
    return this.orgs.demoPlatformAdmins();
  }

  /** Branding for a brand's own sign-in page (/b/:slug). */
  @Get("auth/brand/:slug") @Public()
  brand(@Param("slug") slug: string) {
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) return this.orgs.publicBrand("__none__");
    return this.orgs.publicBrand(slug);
  }
}
