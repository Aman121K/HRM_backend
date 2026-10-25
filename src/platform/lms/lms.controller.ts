import { Body, Controller, Delete, Get, Header, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { Roles } from "../auth/roles.decorator";
import {
  AssignDto, AttemptDto, CatalogQuery, CourseInputDto, CourseStatusDto, CourseVersionDto, LessonInputDto, RemindersDto, ReorderLessonsDto,
  ResetAttemptsDto, UpdateCourseDto, UpdateLessonDto,
} from "./lms.dto";
import { LmsService } from "./lms.service";

const AUTHORS = ["HR_ADMIN", "OWNER", "MANAGER"];

@ApiTags("learning") @ApiBearerAuth() @Controller("api/v2/lms")
export class LmsController {
  constructor(private readonly lms: LmsService) {}

  // Learner
  @Get("options") @ApiOperation({ summary: "Categories, viewer capabilities and assignable people" })
  options(@Req() request: FastifyRequest) { return this.lms.options(request.identity!); }

  @Get("catalog") @ApiOperation({ summary: "Published courses visible to the viewer, with their own progress" })
  catalog(@Req() request: FastifyRequest, @Query() query: CatalogQuery) { return this.lms.catalog(request.identity!, query); }

  @Get("me") @ApiOperation({ summary: "My learning: enrolments, due dates, certificates and hours learned" })
  me(@Req() request: FastifyRequest) { return this.lms.myLearning(request.identity!); }

  @Get("courses/:id")
  course(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.lms.course(request.identity!, id); }

  @Post("courses/:id/enroll")
  enroll(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.lms.enroll(request.identity!, id); }

  @Get("courses/:id/lessons/:lessonId") @ApiOperation({ summary: "Lesson content (quiz questions without answers)" })
  lesson(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Param("lessonId", ParseUUIDPipe) lessonId: string) {
    return this.lms.lesson(request.identity!, id, lessonId);
  }

  @Post("courses/:id/lessons/:lessonId/open")
  open(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Param("lessonId", ParseUUIDPipe) lessonId: string) {
    return this.lms.openLesson(request.identity!, id, lessonId);
  }

  @Post("courses/:id/lessons/:lessonId/complete")
  complete(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Param("lessonId", ParseUUIDPipe) lessonId: string) {
    return this.lms.completeLesson(request.identity!, id, lessonId);
  }

  @Post("courses/:id/lessons/:lessonId/attempts") @ApiOperation({ summary: "Submit quiz answers; graded on the server" })
  attempt(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Param("lessonId", ParseUUIDPipe) lessonId: string, @Body() input: AttemptDto) {
    return this.lms.attempt(request.identity!, id, lessonId, input);
  }

  @Get("certificates/verify/:code") @ApiOperation({ summary: "Check a certificate verification code" })
  verify(@Req() request: FastifyRequest, @Param("code") code: string) { return this.lms.verify(request.identity!, code); }

  @Get("certificates/:id")
  certificate(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.lms.certificate(request.identity!, id); }

  // Managers & HR
  @Get("team") @Roles(...AUTHORS) @ApiOperation({ summary: "Direct reports' learning progress" })
  team(@Req() request: FastifyRequest) { return this.lms.team(request.identity!); }

  @Get("team.csv") @Roles(...AUTHORS) @Header("content-type", "text/csv; charset=utf-8") @Header("content-disposition", 'attachment; filename="team-learning.csv"')
  @Header("cache-control", "private, no-store")
  teamCsv(@Req() request: FastifyRequest) { return this.lms.exportCsv(request.identity!, "team"); }

  @Get("admin/analytics") @Roles("HR_ADMIN", "OWNER")
  analytics(@Req() request: FastifyRequest) { return this.lms.analytics(request.identity!); }

  @Get("admin/export.csv") @Roles("HR_ADMIN", "OWNER") @Header("content-type", "text/csv; charset=utf-8")
  @Header("content-disposition", 'attachment; filename="learning-records.csv"') @Header("cache-control", "private, no-store")
  exportCsv(@Req() request: FastifyRequest) { return this.lms.exportCsv(request.identity!, "all"); }

  @Post("admin/reminders") @Roles(...AUTHORS) @ApiOperation({ summary: "Notify learners whose courses are due soon or overdue" })
  reminders(@Req() request: FastifyRequest, @Body() input: RemindersDto) { return this.lms.reminders(request.identity!, input); }

  @Get("admin/courses") @Roles(...AUTHORS)
  adminCourses(@Req() request: FastifyRequest) { return this.lms.adminCourses(request.identity!); }

  @Post("admin/courses") @Roles(...AUTHORS)
  createCourse(@Req() request: FastifyRequest, @Body() input: CourseInputDto) { return this.lms.createCourse(request.identity!, input); }

  @Get("admin/courses/:id") @Roles(...AUTHORS)
  adminCourse(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.lms.adminCourse(request.identity!, id); }

  @Patch("admin/courses/:id") @Roles(...AUTHORS)
  updateCourse(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: UpdateCourseDto) {
    return this.lms.updateCourse(request.identity!, id, input);
  }

  @Post("admin/courses/:id/status") @Roles(...AUTHORS)
  status(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: CourseStatusDto) {
    return this.lms.setStatus(request.identity!, id, input);
  }

  @Get("admin/courses/:id/learners") @Roles(...AUTHORS)
  learners(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string) { return this.lms.learners(request.identity!, id); }

  @Post("admin/courses/:id/assign") @Roles(...AUTHORS)
  assign(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: AssignDto) {
    return this.lms.assign(request.identity!, id, input);
  }

  @Post("admin/courses/:id/lessons") @Roles(...AUTHORS)
  addLesson(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: LessonInputDto) {
    return this.lms.addLesson(request.identity!, id, input);
  }

  @Post("admin/courses/:id/lessons/reorder") @Roles(...AUTHORS)
  reorder(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: ReorderLessonsDto) {
    return this.lms.reorder(request.identity!, id, input);
  }

  @Patch("admin/courses/:id/lessons/:lessonId") @Roles(...AUTHORS)
  updateLesson(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Param("lessonId", ParseUUIDPipe) lessonId: string, @Body() input: UpdateLessonDto) {
    return this.lms.updateLesson(request.identity!, id, lessonId, input);
  }

  @Delete("admin/courses/:id/lessons/:lessonId") @Roles(...AUTHORS)
  removeLesson(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Param("lessonId", ParseUUIDPipe) lessonId: string, @Query() query: CourseVersionDto) {
    return this.lms.removeLesson(request.identity!, id, lessonId, query.courseVersion);
  }

  @Post("admin/enrollments/:id/reset-attempts") @Roles(...AUTHORS)
  resetAttempts(@Req() request: FastifyRequest, @Param("id", ParseUUIDPipe) id: string, @Body() input: ResetAttemptsDto) {
    return this.lms.resetAttempts(request.identity!, id, input.lessonId);
  }
}
