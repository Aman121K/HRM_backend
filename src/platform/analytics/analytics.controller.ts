import { Controller, Get, Header, Param, Query, Req, StreamableFile } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { AnalyticsQuery } from "./analytics.dto";
import { AnalyticsService } from "./analytics.service";

@ApiTags("analytics") @ApiBearerAuth() @Controller("api/v2/analytics")
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get("overview") @Header("cache-control", "private, no-store")
  @ApiOperation({ summary: "Executive overview: KPI tiles with deltas, trend charts and generated insights" })
  overview(@Req() request: FastifyRequest, @Query() query: AnalyticsQuery) { return this.analytics.overview(request.identity!, query); }

  @Get("filters") @ApiOperation({ summary: "Departments, locations and date bounds the viewer may filter by" })
  filters(@Req() request: FastifyRequest) { return this.analytics.filterOptions(request.identity!); }

  @Get("reports") @ApiOperation({ summary: "Report catalogue available to the viewer" })
  catalogue(@Req() request: FastifyRequest) { return this.analytics.catalogue(request.identity!); }

  @Get("reports/:slug") @Header("cache-control", "private, no-store")
  @ApiOperation({ summary: "Run one report (KPIs, charts, table, definitions)" })
  report(@Req() request: FastifyRequest, @Param("slug") slug: string, @Query() query: AnalyticsQuery) {
    return this.analytics.report(request.identity!, slug, query);
  }

  @Get("reports/:slug/export") @Header("cache-control", "private, no-store") @Header("x-content-type-options", "nosniff")
  @ApiOperation({ summary: "Download the report table as CSV (audited)" })
  async export(@Req() request: FastifyRequest, @Param("slug") slug: string, @Query() query: AnalyticsQuery) {
    const file = await this.analytics.exportCsv(request.identity!, slug, query);
    return new StreamableFile(file.bytes, { type: "text/csv; charset=utf-8", disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, length: file.bytes.length });
  }
}
