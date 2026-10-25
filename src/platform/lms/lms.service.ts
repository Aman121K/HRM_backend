import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { randomInt } from "node:crypto";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { FilesService } from "../files/files.service";
import {
  LMS_CATEGORIES, LMS_LEVELS, type AssignDto, type AttemptDto, type CatalogQuery, type CourseInputDto, type CourseStatusDto,
  type LessonInputDto, type QuestionDto, type RemindersDto, type ReorderLessonsDto, type UpdateCourseDto, type UpdateLessonDto,
} from "./lms.dto";

type Row = Record<string, any>;
type Me = { id: string; full_name: string; manager_id: string | null; department: string | null; location: string | null };
const HR_ROLES = ["HR_ADMIN", "OWNER"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_PASS_MARK = 70;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const COURSE_COLUMNS = `
  c.id, c.title, c.summary, c.description, c.category, c.level, c.duration_minutes, c.cover_color, c.cover_emoji, c.mandatory,
  c.mandatory_due_days, c.status, c.team_manager_id, c.author_id, c.version, c.published_at, c.created_at, c.updated_at,
  a.full_name AS author_name, tm.full_name AS team_manager_name,
  (SELECT count(*)::int FROM lms_lessons l WHERE l.organization_id=c.organization_id AND l.course_id=c.id AND l.deleted_at IS NULL) AS lesson_count,
  (SELECT count(*)::int FROM lms_enrollments x WHERE x.organization_id=c.organization_id AND x.course_id=c.id) AS learner_count`;
const COURSE_FROM = `
  FROM lms_courses c
  JOIN employees a ON a.id=c.author_id AND a.organization_id=c.organization_id
  LEFT JOIN employees tm ON tm.id=c.team_manager_id AND tm.organization_id=c.organization_id`;
const ENROLLMENT_COLUMNS = `
  e.id AS e_id, e.status AS e_status, e.progress_pct AS e_progress, to_char(e.due_date,'YYYY-MM-DD') AS e_due, e.source AS e_source,
  e.last_lesson_id AS e_last_lesson, e.started_at AS e_started, e.completed_at AS e_completed, e.created_at AS e_created,
  (e.due_date IS NOT NULL AND e.status<>'COMPLETED' AND e.due_date < current_date) AS e_overdue,
  (e.due_date IS NOT NULL AND e.status<>'COMPLETED' AND e.due_date >= current_date AND e.due_date <= current_date + 7) AS e_due_soon,
  ab.full_name AS e_assigned_by, cert.id AS e_certificate_id, cert.verification_code AS e_certificate_code`;
const ENROLLMENT_JOINS = `
  LEFT JOIN employees ab ON ab.id=e.assigned_by AND ab.organization_id=e.organization_id
  LEFT JOIN lms_certificates cert ON cert.enrollment_id=e.id AND cert.organization_id=e.organization_id`;

@Injectable()
export class LmsService implements OnModuleInit {
  constructor(private readonly database: DatabaseService, private readonly files: FilesService) {}

  onModuleInit() {
    // PDF handouts on lessons: authors (HR, or the manager who owns a team course) upload; anyone who can open the course reads.
    this.files.registerPolicy("lms_lesson", async (identity, lessonId, client) => {
      const lesson = (await client.query(`SELECT course_id FROM lms_lessons WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL`,
        [identity.organizationId, lessonId])).rows[0];
      if (!lesson) return null;
      const course = await this.findCourse(client, identity, lesson.course_id);
      if (!course) return null;
      const me = await this.me(client, identity);
      if (this.canManage(identity, course)) return "write";
      return (await this.canView(client, identity, me, course)) ? "read" : null;
    });
  }

  // ---- learner -----------------------------------------------------------------------------------

  options(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const me = await this.me(client, identity);
      const isHr = this.isHr(identity);
      const reports = (await client.query(
        `SELECT id, employee_number AS "employeeNumber", full_name AS "fullName", designation, department, location
           FROM employees WHERE organization_id=$1 AND manager_id=$2 AND status='ACTIVE' ORDER BY full_name`, [identity.organizationId, me.id])).rows;
      const people = isHr ? (await client.query(
        `SELECT id, employee_number AS "employeeNumber", full_name AS "fullName", designation, department, location
           FROM employees WHERE organization_id=$1 AND status='ACTIVE' ORDER BY full_name LIMIT 1000`, [identity.organizationId])).rows : reports;
      const departments = isHr ? (await client.query(
        `SELECT DISTINCT department FROM employees WHERE organization_id=$1 AND status='ACTIVE' AND department IS NOT NULL ORDER BY 1`, [identity.organizationId])).rows.map((row) => row.department) : [];
      const locations = isHr ? (await client.query(
        `SELECT DISTINCT location FROM employees WHERE organization_id=$1 AND status='ACTIVE' AND location IS NOT NULL ORDER BY 1`, [identity.organizationId])).rows.map((row) => row.location) : [];
      return {
        categories: LMS_CATEGORIES, levels: LMS_LEVELS,
        viewer: { employeeId: me.id, name: me.full_name, roles: identity.roles, isHr, isManager: this.isManager(identity), canAuthor: isHr || this.isManager(identity), hasReports: reports.length > 0 },
        people, departments, locations,
      };
    });
  }

  catalog(identity: AuthIdentity, query: CatalogQuery) {
    return this.database.tenantTransaction(identity, async (client) => {
      const me = await this.me(client, identity);
      await this.ensureMandatory(client, identity, me.id);
      const values: unknown[] = [identity.organizationId, me.id, me.manager_id];
      const where = [`c.organization_id=$1`, `c.status='PUBLISHED'`, `(c.team_manager_id IS NULL OR c.team_manager_id=$3 OR c.team_manager_id=$2)`];
      if (query.category) { values.push(query.category); where.push(`c.category=$${values.length}`); }
      if (query.search?.trim()) {
        values.push(query.search.trim());
        where.push(`(c.title ILIKE '%'||$${values.length}||'%' OR c.summary ILIKE '%'||$${values.length}||'%' OR c.category ILIKE '%'||$${values.length}||'%')`);
      }
      const rows = (await client.query(
        `SELECT ${COURSE_COLUMNS}, ${ENROLLMENT_COLUMNS} ${COURSE_FROM}
           LEFT JOIN lms_enrollments e ON e.course_id=c.id AND e.organization_id=c.organization_id AND e.employee_id=$2 ${ENROLLMENT_JOINS}
          WHERE ${where.join(" AND ")} ORDER BY c.mandatory DESC, c.published_at DESC NULLS LAST, c.title LIMIT 300`, values)).rows;
      const categories = (await client.query(
        `SELECT category, count(*)::int AS count FROM lms_courses c WHERE c.organization_id=$1 AND c.status='PUBLISHED'
            AND (c.team_manager_id IS NULL OR c.team_manager_id=$3 OR c.team_manager_id=$2) GROUP BY category ORDER BY category`,
        [identity.organizationId, me.id, me.manager_id])).rows;
      return { items: rows.map((row) => this.presentCourse(row)), categories };
    });
  }

  myLearning(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const me = await this.me(client, identity);
      await this.ensureMandatory(client, identity, me.id);
      const rows = (await client.query(
        `SELECT ${COURSE_COLUMNS}, ${ENROLLMENT_COLUMNS}, ll.title AS e_last_lesson_title
           FROM lms_enrollments e JOIN lms_courses c ON c.id=e.course_id AND c.organization_id=e.organization_id
           JOIN employees a ON a.id=c.author_id AND a.organization_id=c.organization_id
           LEFT JOIN employees tm ON tm.id=c.team_manager_id AND tm.organization_id=c.organization_id
           LEFT JOIN lms_lessons ll ON ll.id=e.last_lesson_id AND ll.organization_id=e.organization_id ${ENROLLMENT_JOINS}
          WHERE e.organization_id=$1 AND e.employee_id=$2 AND (c.status<>'DRAFT')
          ORDER BY (e.status='COMPLETED'), e.due_date NULLS LAST, e.updated_at DESC`, [identity.organizationId, me.id])).rows;
      const items = rows.map((row) => ({ ...this.presentCourse(row), lastLessonTitle: row.e_last_lesson_title || null }));
      const certificates = (await client.query(
        `SELECT id, verification_code AS code, course_title AS "courseTitle", course_id AS "courseId", issued_at AS "issuedAt", score
           FROM lms_certificates WHERE organization_id=$1 AND employee_id=$2 ORDER BY issued_at DESC`, [identity.organizationId, me.id])).rows;
      const minutes = Number((await client.query(
        `SELECT coalesce(sum(l.duration_minutes),0)::int AS minutes FROM lms_lesson_progress p
           JOIN lms_enrollments e ON e.id=p.enrollment_id AND e.organization_id=p.organization_id
           JOIN lms_lessons l ON l.id=p.lesson_id AND l.organization_id=p.organization_id
          WHERE p.organization_id=$1 AND e.employee_id=$2`, [identity.organizationId, me.id])).rows[0].minutes);
      const active = items.filter((item) => item.enrollment!.status !== "COMPLETED");
      return {
        items, certificates,
        stats: {
          inProgress: active.filter((item) => item.enrollment!.status === "IN_PROGRESS").length,
          assigned: active.filter((item) => item.enrollment!.source !== "SELF").length,
          overdue: active.filter((item) => item.enrollment!.overdue).length,
          dueSoon: active.filter((item) => item.enrollment!.dueSoon).length,
          completed: items.length - active.length,
          minutesLearned: minutes,
          certificates: certificates.length,
        },
      };
    });
  }

  course(identity: AuthIdentity, id: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const me = await this.me(client, identity);
      const course = await this.requireCourse(client, identity, me, id);
      const enrollment = await this.enrollmentFor(client, identity, course.id, me.id);
      const row = { ...course, ...(enrollment || {}) };
      const lessons = (await client.query(
        `SELECT l.id, l.title, l.type, l.duration_minutes AS "durationMinutes", l.position,
                ${enrollment ? `(p.lesson_id IS NOT NULL)` : "false"} AS completed
           FROM lms_lessons l ${enrollment ? `LEFT JOIN lms_lesson_progress p ON p.lesson_id=l.id AND p.enrollment_id=$3 AND p.organization_id=l.organization_id` : ""}
          WHERE l.organization_id=$1 AND l.course_id=$2 AND l.deleted_at IS NULL ORDER BY l.position, l.created_at`,
        enrollment ? [identity.organizationId, id, enrollment.e_id] : [identity.organizationId, id])).rows;
      return { ...this.presentCourse(row), lessons, canManage: this.canManage(identity, course) };
    });
  }

  enroll(identity: AuthIdentity, id: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const me = await this.me(client, identity);
      const course = await this.requireCourse(client, identity, me, id);
      if (course.status !== "PUBLISHED") throw new ConflictException("Only published courses are open for enrolment.");
      const inserted = (await client.query(
        `INSERT INTO lms_enrollments(organization_id,course_id,employee_id,source) VALUES($1,$2,$3,'SELF')
         ON CONFLICT (organization_id,course_id,employee_id) DO NOTHING RETURNING id`, [identity.organizationId, id, me.id])).rows[0];
      if (inserted) await this.audit(client, identity, "LMS_ENROLLED", "lms_enrollment", inserted.id, { courseId: id, source: "SELF" });
      return { enrolled: true, created: !!inserted };
    });
  }

  lesson(identity: AuthIdentity, courseId: string, lessonId: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const me = await this.me(client, identity);
      const course = await this.requireCourse(client, identity, me, courseId);
      const lesson = await this.requireLesson(client, identity, courseId, lessonId);
      const enrollment = await this.enrollmentFor(client, identity, courseId, me.id);
      const preview = !enrollment;
      if (preview && !this.canManage(identity, course)) throw new ForbiddenException("Enrol in this course to open its lessons.");
      const completed = enrollment ? !!(await client.query(`SELECT 1 FROM lms_lesson_progress WHERE enrollment_id=$1 AND lesson_id=$2`, [enrollment.e_id, lessonId])).rowCount : false;
      const base = {
        id: lesson.id, courseId, title: lesson.title, type: lesson.type, body: lesson.body, durationMinutes: lesson.duration_minutes,
        videoUrl: lesson.video_url, embedUrl: lesson.video_url ? videoEmbed(lesson.video_url) : null, completed, preview,
      };
      if (lesson.type !== "QUIZ") return base;
      // Learners get prompts and options only — correct answers stay on the server until an attempt is graded.
      const questions = (await client.query(
        `SELECT id, prompt, kind, options FROM lms_questions WHERE organization_id=$1 AND lesson_id=$2 ORDER BY position`, [identity.organizationId, lessonId])).rows;
      const quiz = enrollment ? await this.attemptSummary(client, identity, enrollment.e_id, lesson) : { attemptsUsed: 0, attemptsLeft: lesson.max_attempts || null, bestScore: null, passed: false, locked: false };
      return { ...base, passMark: lesson.pass_mark || DEFAULT_PASS_MARK, maxAttempts: lesson.max_attempts || null, questions, quiz };
    });
  }

  /** Remember where the learner is so "Resume" reopens the same lesson. */
  openLesson(identity: AuthIdentity, courseId: string, lessonId: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const me = await this.me(client, identity);
      await this.requireCourse(client, identity, me, courseId);
      await this.requireLesson(client, identity, courseId, lessonId);
      const enrollment = await this.enrollmentFor(client, identity, courseId, me.id);
      if (!enrollment) return { tracked: false };
      await client.query(
        `UPDATE lms_enrollments SET last_lesson_id=$3, updated_at=now(), started_at=coalesce(started_at,now()),
                status=CASE WHEN status='NOT_STARTED' THEN 'IN_PROGRESS' ELSE status END
          WHERE organization_id=$1 AND id=$2`, [identity.organizationId, enrollment.e_id, lessonId]);
      return { tracked: true };
    });
  }

  completeLesson(identity: AuthIdentity, courseId: string, lessonId: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const me = await this.me(client, identity);
      await this.requireCourse(client, identity, me, courseId);
      const lesson = await this.requireLesson(client, identity, courseId, lessonId);
      if (lesson.type === "QUIZ") throw new BadRequestException("Pass the quiz to complete this lesson.");
      const enrollment = await this.lockEnrollment(client, identity, courseId, me.id);
      await client.query(
        `INSERT INTO lms_lesson_progress(organization_id,enrollment_id,lesson_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [identity.organizationId, enrollment.id, lessonId]);
      await client.query(`UPDATE lms_enrollments SET last_lesson_id=$3, started_at=coalesce(started_at,now()) WHERE organization_id=$1 AND id=$2`,
        [identity.organizationId, enrollment.id, lessonId]);
      return this.recompute(client, identity, enrollment.id);
    });
  }

  attempt(identity: AuthIdentity, courseId: string, lessonId: string, input: AttemptDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const me = await this.me(client, identity);
      await this.requireCourse(client, identity, me, courseId);
      const lesson = await this.requireLesson(client, identity, courseId, lessonId);
      if (lesson.type !== "QUIZ") throw new BadRequestException("This lesson is not a quiz.");
      const enrollment = await this.lockEnrollment(client, identity, courseId, me.id);
      const before = await this.attemptSummary(client, identity, enrollment.id, lesson);
      if (before.passed) throw new ConflictException("You have already passed this quiz.");
      if (before.locked) throw new ConflictException("You have used every attempt for this quiz. Ask HR or your manager to reset it.");
      const questions = (await client.query(
        `SELECT id, prompt, kind, options, correct, explanation FROM lms_questions WHERE organization_id=$1 AND lesson_id=$2 ORDER BY position`,
        [identity.organizationId, lessonId])).rows;
      if (!questions.length) throw new ConflictException("This quiz has no questions yet.");
      const answers = input.answers || {};
      const known = new Set(questions.map((question) => question.id));
      for (const key of Object.keys(answers)) if (!known.has(key)) throw new BadRequestException("The answers include an unknown question.");
      const cleaned: Record<string, string[]> = {};
      let right = 0;
      const graded = questions.map((question) => {
        const raw = answers[question.id];
        const picked = Array.isArray(raw) ? [...new Set(raw.map(String))].filter((id) => question.options.some((option: Row) => option.id === id)) : [];
        if (question.kind === "SINGLE" && picked.length > 1) throw new BadRequestException("Choose only one answer for single-choice questions.");
        cleaned[question.id] = picked;
        const correct = [...question.correct].sort().join("|") === [...picked].sort().join("|");
        if (correct) right += 1;
        return { question, picked, correct };
      });
      const unanswered = graded.filter((item) => !item.picked.length).length;
      if (unanswered) throw new BadRequestException(`Answer every question before submitting (${unanswered} left).`);
      const score = Math.round((right / questions.length) * 100);
      const passMark = lesson.pass_mark || DEFAULT_PASS_MARK;
      const passed = score >= passMark;
      await client.query(
        `INSERT INTO lms_quiz_attempts(organization_id,enrollment_id,lesson_id,answers,score,passed) VALUES($1,$2,$3,$4,$5,$6)`,
        [identity.organizationId, enrollment.id, lessonId, JSON.stringify(cleaned), score, passed]);
      await client.query(`UPDATE lms_enrollments SET last_lesson_id=$3, started_at=coalesce(started_at,now()),
                            status=CASE WHEN status='NOT_STARTED' THEN 'IN_PROGRESS' ELSE status END, updated_at=now() WHERE organization_id=$1 AND id=$2`,
        [identity.organizationId, enrollment.id, lessonId]);
      if (passed) await client.query(`INSERT INTO lms_lesson_progress(organization_id,enrollment_id,lesson_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [identity.organizationId, enrollment.id, lessonId]);
      const after = await this.attemptSummary(client, identity, enrollment.id, lesson);
      // Correct answers are revealed only once they can no longer help a retake.
      const reveal = passed || after.locked;
      const progress = await this.recompute(client, identity, enrollment.id);
      return {
        score, passMark, correctCount: right, total: questions.length, ...after, passed, reveal,
        results: graded.map(({ question, picked, correct }) => ({
          questionId: question.id, correct, picked, explanation: reveal || correct ? question.explanation || null : null, correctOptions: reveal ? question.correct : null,
        })),
        enrollment: progress,
      };
    });
  }

  certificate(identity: AuthIdentity, id: string) {
    if (!UUID.test(id)) throw new NotFoundException("Certificate not found.");
    return this.database.tenantTransaction(identity, async (client) => {
      const row = (await client.query(
        `SELECT cert.*, e.employee_number, e.designation, e.manager_id, c.category, c.duration_minutes, c.cover_color, c.cover_emoji, o.name AS organization_name
           FROM lms_certificates cert JOIN employees e ON e.id=cert.employee_id AND e.organization_id=cert.organization_id
           JOIN lms_courses c ON c.id=cert.course_id AND c.organization_id=cert.organization_id
           JOIN organizations o ON o.id=cert.organization_id
          WHERE cert.organization_id=$1 AND cert.id=$2`, [identity.organizationId, id])).rows[0];
      if (!row || !(row.employee_id === identity.employeeId || this.isHr(identity) || row.manager_id === identity.employeeId))
        throw new NotFoundException("Certificate not found.");
      return {
        id: row.id, code: row.verification_code, courseTitle: row.course_title, employeeName: row.employee_name, employeeNumber: row.employee_number,
        designation: row.designation, category: row.category, durationMinutes: row.duration_minutes, coverColor: row.cover_color, coverEmoji: row.cover_emoji,
        organizationName: row.organization_name, issuedAt: row.issued_at, score: row.score, courseVersion: row.course_version, courseId: row.course_id,
      };
    });
  }

  verify(identity: AuthIdentity, code: string) {
    const normalized = String(code || "").trim().toUpperCase();
    if (!/^NS-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalized)) return { valid: false, code: normalized };
    return this.database.tenantTransaction(identity, async (client) => {
      const row = (await client.query(
        `SELECT verification_code, course_title, employee_name, issued_at FROM lms_certificates WHERE organization_id=$1 AND verification_code=$2`,
        [identity.organizationId, normalized])).rows[0];
      return row ? { valid: true, code: row.verification_code, courseTitle: row.course_title, employeeName: row.employee_name, issuedAt: row.issued_at } : { valid: false, code: normalized };
    });
  }

  // ---- managers & HR -----------------------------------------------------------------------------

  team(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const me = await this.me(client, identity);
      const rows = (await client.query(
        `SELECT m.id AS employee_id, m.full_name, m.employee_number, m.designation, m.location,
                e.id AS enrollment_id, e.status, e.progress_pct, to_char(e.due_date,'YYYY-MM-DD') AS due_date, e.source, e.completed_at,
                (e.due_date IS NOT NULL AND e.status<>'COMPLETED' AND e.due_date < current_date) AS overdue,
                c.id AS course_id, c.title, c.mandatory, c.cover_emoji, c.cover_color
           FROM employees m
           LEFT JOIN lms_enrollments e ON e.employee_id=m.id AND e.organization_id=m.organization_id
           LEFT JOIN lms_courses c ON c.id=e.course_id AND c.organization_id=e.organization_id AND c.status<>'DRAFT'
          WHERE m.organization_id=$1 AND m.manager_id=$2 AND m.status='ACTIVE'
          ORDER BY m.full_name, e.due_date NULLS LAST`, [identity.organizationId, me.id])).rows;
      const people = new Map<string, Row>();
      for (const row of rows) {
        if (!people.has(row.employee_id)) people.set(row.employee_id, {
          id: row.employee_id, name: row.full_name, employeeNumber: row.employee_number, designation: row.designation, location: row.location,
          enrollments: [], total: 0, completed: 0, overdue: 0,
        });
        const person = people.get(row.employee_id)!;
        if (!row.enrollment_id || !row.course_id) continue;
        person.enrollments.push({
          id: row.enrollment_id, courseId: row.course_id, title: row.title, mandatory: row.mandatory, coverEmoji: row.cover_emoji, coverColor: row.cover_color,
          status: row.status, progressPct: row.progress_pct, dueDate: row.due_date, source: row.source, completedAt: row.completed_at, overdue: row.overdue,
        });
        person.total += 1;
        if (row.status === "COMPLETED") person.completed += 1;
        if (row.overdue) person.overdue += 1;
      }
      const members: Row[] = [...people.values()].map((person) => ({ ...person, completionPct: person.total ? Math.round((person.completed / person.total) * 100) : null }));
      const total = members.reduce((sum, person) => sum + person.total, 0);
      const completed = members.reduce((sum, person) => sum + person.completed, 0);
      return {
        members,
        stats: {
          members: members.length, enrollments: total, completed, completionPct: total ? Math.round((completed / total) * 100) : 0,
          overdue: members.reduce((sum, person) => sum + person.overdue, 0),
          inProgress: members.reduce((sum, person) => sum + person.enrollments.filter((item: Row) => item.status === "IN_PROGRESS").length, 0),
        },
      };
    });
  }

  adminCourses(identity: AuthIdentity) {
    this.requireAuthor(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const me = await this.me(client, identity);
      const rows = (await client.query(
        `SELECT ${COURSE_COLUMNS},
                (SELECT count(*)::int FROM lms_enrollments x WHERE x.organization_id=c.organization_id AND x.course_id=c.id AND x.status='COMPLETED') AS completed_count
           ${COURSE_FROM} WHERE c.organization_id=$1 AND ($2 OR (c.team_manager_id=$3 AND c.author_id=$3))
          ORDER BY CASE c.status WHEN 'DRAFT' THEN 0 WHEN 'PUBLISHED' THEN 1 ELSE 2 END, c.updated_at DESC`,
        [identity.organizationId, this.isHr(identity), me.id])).rows;
      return { items: rows.map((row) => ({ ...this.presentCourse(row), completedCount: row.completed_count })) };
    });
  }

  adminCourse(identity: AuthIdentity, id: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const course = await this.manageable(client, identity, id);
      return this.builderView(client, identity, course.id);
    });
  }

  createCourse(identity: AuthIdentity, input: CourseInputDto) {
    this.requireAuthor(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const me = await this.me(client, identity);
      const hr = this.isHr(identity);
      if (input.mandatory && !hr) throw new ForbiddenException("Only HR can make a course mandatory.");
      const row = (await client.query(
        `INSERT INTO lms_courses(organization_id,title,summary,description,category,level,duration_minutes,cover_color,cover_emoji,mandatory,mandatory_due_days,team_manager_id,author_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [identity.organizationId, input.title.trim(), (input.summary || "").trim(), (input.description || "").trim(), input.category, input.level || "BEGINNER",
          input.durationMinutes || 30, input.coverColor || "#0b615c", input.coverEmoji || "📘", !!input.mandatory, input.mandatoryDueDays || 30,
          hr ? null : me.id, me.id])).rows[0];
      await this.audit(client, identity, "LMS_COURSE_CREATED", "lms_course", row.id, { title: input.title, category: input.category, teamCourse: !hr });
      return this.builderView(client, identity, row.id);
    });
  }

  updateCourse(identity: AuthIdentity, id: string, input: UpdateCourseDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const course = await this.manageable(client, identity, id, true);
      this.checkVersion(course, input.version);
      if (input.mandatory !== undefined && input.mandatory !== course.mandatory && !this.isHr(identity))
        throw new ForbiddenException("Only HR can change whether a course is mandatory.");
      if (input.mandatory && course.team_manager_id) throw new BadRequestException("Team courses cannot be mandatory.");
      const map: Record<string, string> = {
        title: "title", summary: "summary", description: "description", category: "category", level: "level", durationMinutes: "duration_minutes",
        coverColor: "cover_color", coverEmoji: "cover_emoji", mandatory: "mandatory", mandatoryDueDays: "mandatory_due_days",
      };
      const sets = ["version=version+1", "updated_at=now()"];
      const values: unknown[] = [identity.organizationId, id];
      const changes: Row = {};
      for (const [key, column] of Object.entries(map)) {
        const value = (input as Row)[key];
        if (value === undefined) continue;
        const clean = typeof value === "string" ? value.trim() : value;
        values.push(clean); sets.push(`${column}=$${values.length}`); changes[key] = clean;
      }
      await client.query(`UPDATE lms_courses SET ${sets.join(",")} WHERE organization_id=$1 AND id=$2`, values);
      await this.audit(client, identity, "LMS_COURSE_UPDATED", "lms_course", id, changes, pick(course, Object.values(map)));
      if (course.status === "PUBLISHED" && (changes.mandatory ?? course.mandatory)) await this.applyMandatory(client, identity, id);
      return this.builderView(client, identity, id);
    });
  }

  setStatus(identity: AuthIdentity, id: string, input: CourseStatusDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const course = await this.manageable(client, identity, id, true);
      this.checkVersion(course, input.version);
      if (course.status === input.status) throw new ConflictException(`The course is already ${input.status.toLowerCase()}.`);
      if (input.status === "PUBLISHED") await this.validateForPublish(client, identity, id);
      if (input.status === "DRAFT" && course.status === "PUBLISHED") {
        const learners = Number((await client.query(`SELECT count(*) FROM lms_enrollments WHERE organization_id=$1 AND course_id=$2`, [identity.organizationId, id])).rows[0].count);
        if (learners) throw new ConflictException("Learners are already enrolled — archive the course instead of moving it back to draft.");
      }
      await client.query(
        `UPDATE lms_courses SET status=$3, version=version+1, updated_at=now(), published_at=CASE WHEN $3='PUBLISHED' THEN coalesce(published_at,now()) ELSE published_at END
          WHERE organization_id=$1 AND id=$2`, [identity.organizationId, id, input.status]);
      await this.audit(client, identity, `LMS_COURSE_${input.status}`, "lms_course", id, { status: input.status }, { status: course.status });
      let enrolled = 0;
      if (input.status === "PUBLISHED" && course.mandatory) enrolled = await this.applyMandatory(client, identity, id);
      return { ...(await this.builderView(client, identity, id)), mandatoryEnrolled: enrolled };
    });
  }

  addLesson(identity: AuthIdentity, courseId: string, input: LessonInputDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const course = await this.manageable(client, identity, courseId, true);
      this.checkVersion(course, input.courseVersion);
      const fields = this.lessonFields(input.type, input);
      const position = Number((await client.query(
        `SELECT coalesce(max(position)+1,0) AS next FROM lms_lessons WHERE organization_id=$1 AND course_id=$2 AND deleted_at IS NULL`, [identity.organizationId, courseId])).rows[0].next);
      const row = (await client.query(
        `INSERT INTO lms_lessons(organization_id,course_id,position,title,type,body,video_url,duration_minutes,pass_mark,max_attempts)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [identity.organizationId, courseId, position, input.title.trim(), input.type, fields.body, fields.videoUrl, fields.durationMinutes, fields.passMark, fields.maxAttempts])).rows[0];
      if (input.type === "QUIZ") await this.replaceQuestions(client, identity, row.id, input.questions || []);
      await this.touchCourse(client, identity, courseId);
      await this.audit(client, identity, "LMS_LESSON_ADDED", "lms_course", courseId, { lessonId: row.id, title: input.title, type: input.type });
      return { ...(await this.builderView(client, identity, courseId)), lessonId: row.id };
    });
  }

  updateLesson(identity: AuthIdentity, courseId: string, lessonId: string, input: UpdateLessonDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const course = await this.manageable(client, identity, courseId, true);
      this.checkVersion(course, input.courseVersion);
      const lesson = await this.requireLesson(client, identity, courseId, lessonId);
      const merged = {
        body: input.body ?? lesson.body, videoUrl: input.videoUrl ?? lesson.video_url ?? undefined, durationMinutes: input.durationMinutes ?? lesson.duration_minutes,
        passMark: input.passMark ?? lesson.pass_mark ?? undefined, maxAttempts: input.maxAttempts ?? lesson.max_attempts ?? undefined,
      };
      const fields = this.lessonFields(lesson.type, merged);
      await client.query(
        `UPDATE lms_lessons SET title=$3, body=$4, video_url=$5, duration_minutes=$6, pass_mark=$7, max_attempts=$8, updated_at=now()
          WHERE organization_id=$1 AND id=$2`,
        [identity.organizationId, lessonId, (input.title ?? lesson.title).trim(), fields.body, fields.videoUrl, fields.durationMinutes, fields.passMark, fields.maxAttempts]);
      if (lesson.type === "QUIZ" && input.questions) {
        if (course.status === "PUBLISHED" && !input.questions.length) throw new BadRequestException("A published quiz needs at least one question.");
        await this.replaceQuestions(client, identity, lessonId, input.questions);
      }
      await this.touchCourse(client, identity, courseId);
      await this.audit(client, identity, "LMS_LESSON_UPDATED", "lms_course", courseId, { lessonId, title: input.title, questions: input.questions?.length },
        { title: lesson.title, body: lesson.body?.slice(0, 200), videoUrl: lesson.video_url });
      return this.builderView(client, identity, courseId);
    });
  }

  removeLesson(identity: AuthIdentity, courseId: string, lessonId: string, courseVersion: number) {
    return this.database.tenantTransaction(identity, async (client) => {
      const course = await this.manageable(client, identity, courseId, true);
      this.checkVersion(course, courseVersion);
      const lesson = await this.requireLesson(client, identity, courseId, lessonId);
      const remaining = Number((await client.query(`SELECT count(*) FROM lms_lessons WHERE organization_id=$1 AND course_id=$2 AND deleted_at IS NULL`, [identity.organizationId, courseId])).rows[0].count);
      if (course.status === "PUBLISHED" && remaining <= 1) throw new ConflictException("A published course needs at least one lesson.");
      await client.query(`UPDATE lms_lessons SET deleted_at=now() WHERE organization_id=$1 AND id=$2`, [identity.organizationId, lessonId]);
      await client.query(`UPDATE lms_enrollments SET last_lesson_id=NULL WHERE organization_id=$1 AND course_id=$2 AND last_lesson_id=$3`, [identity.organizationId, courseId, lessonId]);
      await this.touchCourse(client, identity, courseId);
      // Progress percentages shift when a lesson disappears; completed learners keep their completion.
      const open = (await client.query(`SELECT id FROM lms_enrollments WHERE organization_id=$1 AND course_id=$2 AND status<>'COMPLETED'`, [identity.organizationId, courseId])).rows;
      for (const row of open) await this.recompute(client, identity, row.id);
      await this.audit(client, identity, "LMS_LESSON_REMOVED", "lms_course", courseId, { lessonId }, { title: lesson.title, type: lesson.type });
      return this.builderView(client, identity, courseId);
    });
  }

  reorder(identity: AuthIdentity, courseId: string, input: ReorderLessonsDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const course = await this.manageable(client, identity, courseId, true);
      this.checkVersion(course, input.courseVersion);
      const current = (await client.query(`SELECT id FROM lms_lessons WHERE organization_id=$1 AND course_id=$2 AND deleted_at IS NULL`, [identity.organizationId, courseId])).rows.map((row) => row.id);
      const unique = new Set(input.lessonIds);
      if (unique.size !== input.lessonIds.length || unique.size !== current.length || current.some((id) => !unique.has(id)))
        throw new BadRequestException("Send every lesson of the course exactly once.");
      for (const [index, id] of input.lessonIds.entries())
        await client.query(`UPDATE lms_lessons SET position=$3 WHERE organization_id=$1 AND id=$2`, [identity.organizationId, id, index]);
      await this.touchCourse(client, identity, courseId);
      await this.audit(client, identity, "LMS_LESSONS_REORDERED", "lms_course", courseId, { lessonIds: input.lessonIds });
      return this.builderView(client, identity, courseId);
    });
  }

  learners(identity: AuthIdentity, courseId: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      await this.manageable(client, identity, courseId);
      const rows = (await client.query(
        `SELECT e.id, e.status, e.progress_pct AS "progressPct", to_char(e.due_date,'YYYY-MM-DD') AS "dueDate", e.source, e.completed_at AS "completedAt",
                e.started_at AS "startedAt", (e.due_date IS NOT NULL AND e.status<>'COMPLETED' AND e.due_date < current_date) AS overdue,
                m.id AS "employeeId", m.full_name AS name, m.employee_number AS "employeeNumber", m.department, m.location,
                (SELECT max(q.score) FROM lms_quiz_attempts q WHERE q.enrollment_id=e.id AND q.organization_id=e.organization_id AND q.voided_at IS NULL) AS "bestScore",
                (SELECT count(*)::int FROM lms_quiz_attempts q WHERE q.enrollment_id=e.id AND q.organization_id=e.organization_id AND q.voided_at IS NULL) AS attempts
           FROM lms_enrollments e JOIN employees m ON m.id=e.employee_id AND m.organization_id=e.organization_id
          WHERE e.organization_id=$1 AND e.course_id=$2 ORDER BY (e.status='COMPLETED'), e.due_date NULLS LAST, m.full_name`,
        [identity.organizationId, courseId])).rows;
      return { items: rows };
    });
  }

  assign(identity: AuthIdentity, courseId: string, input: AssignDto) {
    this.requireAuthor(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const me = await this.me(client, identity);
      const course = await this.requireCourse(client, identity, me, courseId);
      if (course.status !== "PUBLISHED") throw new ConflictException("Publish the course before assigning it.");
      const hr = this.isHr(identity);
      if (!hr && (input.department || input.location)) throw new ForbiddenException("Managers assign courses to their direct reports only.");
      if (input.dueDate) {
        if (Number.isNaN(Date.parse(input.dueDate))) throw new BadRequestException("The due date is not a valid date.");
        if (input.dueDate < new Date().toISOString().slice(0, 10)) throw new BadRequestException("The due date cannot be in the past.");
      }
      const ids = [...new Set(input.employeeIds || [])];
      if (!ids.length && !input.department && !input.location) throw new BadRequestException("Choose at least one employee, department or location.");
      const values: unknown[] = [identity.organizationId, ids];
      const filters = [`id = ANY($2::uuid[])`];
      if (input.department) { values.push(input.department); filters.push(`department=$${values.length}`); }
      if (input.location) { values.push(input.location); filters.push(`location=$${values.length}`); }
      const targets = (await client.query(
        `SELECT id, full_name, manager_id FROM employees WHERE organization_id=$1 AND status='ACTIVE' AND (${filters.join(" OR ")})`, values)).rows;
      if (targets.filter((target) => ids.includes(target.id)).length !== ids.length) throw new BadRequestException("Some selected people are not active employees.");
      if (!hr && targets.some((target) => target.manager_id !== me.id)) throw new ForbiddenException("You can only assign courses to your direct reports.");
      if (course.team_manager_id && targets.some((target) => target.manager_id !== course.team_manager_id && target.id !== course.team_manager_id))
        throw new BadRequestException("This is a team course — it can only be assigned within that team.");
      if (!targets.length) throw new BadRequestException("No active employees match that selection.");
      const due = input.dueDate || (course.mandatory ? addDays(course.mandatory_due_days) : null);
      let assigned = 0, updated = 0, skipped = 0;
      for (const target of targets) {
        const result = (await client.query(
          `INSERT INTO lms_enrollments(organization_id,course_id,employee_id,source,assigned_by,due_date) VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT (organization_id,course_id,employee_id) DO UPDATE
             SET due_date=coalesce(EXCLUDED.due_date,lms_enrollments.due_date), assigned_by=EXCLUDED.assigned_by, reminded_at=NULL, updated_at=now(),
                 source=CASE WHEN lms_enrollments.source='SELF' THEN 'ASSIGNED' ELSE lms_enrollments.source END
           WHERE lms_enrollments.status<>'COMPLETED'
           RETURNING id, (xmax = 0) AS inserted`,
          [identity.organizationId, courseId, target.id, course.mandatory ? "MANDATORY" : "ASSIGNED", me.id, due])).rows[0];
        if (!result) { skipped += 1; continue; }
        if (result.inserted) assigned += 1; else updated += 1;
        if (target.id !== me.id) await this.notify(client, identity, target.id, "LMS_ASSIGNED", result.id, {
          courseId, courseTitle: course.title, dueDate: due, by: me.full_name, href: `/learning/course/${courseId}`,
          message: `${me.full_name} assigned you “${course.title}”${due ? ` · due ${formatDate(due)}` : ""}`, note: input.note?.trim() || undefined,
        });
      }
      await this.audit(client, identity, "LMS_COURSE_ASSIGNED", "lms_course", courseId, {
        employees: targets.map((target) => target.id), department: input.department, location: input.location, dueDate: due, assigned, updated, skipped,
      });
      return { assigned, updated, skipped, total: targets.length, dueDate: due };
    });
  }

  /** Nudges learners whose due date is close or past. Safe to call repeatedly: each enrolment is reminded at most once a day. */
  reminders(identity: AuthIdentity, input: RemindersDto) {
    this.requireAuthor(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const me = await this.me(client, identity);
      const values: unknown[] = [identity.organizationId, input.withinDays || 7];
      const where = [`e.organization_id=$1`, `e.status<>'COMPLETED'`, `e.due_date IS NOT NULL`, `e.due_date <= current_date + $2::int`,
        `(e.reminded_at IS NULL OR e.reminded_at < now() - interval '20 hours')`, `c.status='PUBLISHED'`, `m.status='ACTIVE'`];
      if (!this.isHr(identity)) { values.push(me.id); where.push(`m.manager_id=$${values.length}`); }
      if (input.courseId) { values.push(input.courseId); where.push(`e.course_id=$${values.length}`); }
      const rows = (await client.query(
        `SELECT e.id, e.employee_id, to_char(e.due_date,'YYYY-MM-DD') AS due_date, e.due_date < current_date AS overdue, c.id AS course_id, c.title
           FROM lms_enrollments e JOIN lms_courses c ON c.id=e.course_id AND c.organization_id=e.organization_id
           JOIN employees m ON m.id=e.employee_id AND m.organization_id=e.organization_id
          WHERE ${where.join(" AND ")} FOR UPDATE OF e`, values)).rows;
      for (const row of rows) {
        await this.notify(client, identity, row.employee_id, row.overdue ? "LMS_OVERDUE" : "LMS_DUE_SOON", row.id, {
          courseId: row.course_id, courseTitle: row.title, dueDate: row.due_date, href: `/learning/course/${row.course_id}`,
          message: row.overdue ? `“${row.title}” is overdue (was due ${formatDate(row.due_date)})` : `“${row.title}” is due ${formatDate(row.due_date)}`,
        });
        await client.query(`UPDATE lms_enrollments SET reminded_at=now() WHERE id=$1`, [row.id]);
      }
      if (rows.length) await this.audit(client, identity, "LMS_REMINDERS_SENT", "lms_course", input.courseId || rows[0].course_id, { count: rows.length, courseId: input.courseId || null });
      return { sent: rows.length, overdue: rows.filter((row) => row.overdue).length, dueSoon: rows.filter((row) => !row.overdue).length };
    });
  }

  resetAttempts(identity: AuthIdentity, enrollmentId: string, lessonId: string) {
    if (!UUID.test(enrollmentId)) throw new NotFoundException("Enrolment not found.");
    return this.database.tenantTransaction(identity, async (client) => {
      const row = (await client.query(
        `SELECT e.id, e.course_id, m.manager_id, m.full_name FROM lms_enrollments e JOIN employees m ON m.id=e.employee_id AND m.organization_id=e.organization_id
          WHERE e.organization_id=$1 AND e.id=$2`, [identity.organizationId, enrollmentId])).rows[0];
      if (!row) throw new NotFoundException("Enrolment not found.");
      if (!this.isHr(identity) && row.manager_id !== identity.employeeId) throw new ForbiddenException("Only HR or the learner's manager can reset quiz attempts.");
      const result = await client.query(`UPDATE lms_quiz_attempts SET voided_at=now() WHERE organization_id=$1 AND enrollment_id=$2 AND lesson_id=$3 AND voided_at IS NULL AND NOT passed`,
        [identity.organizationId, enrollmentId, lessonId]);
      await this.audit(client, identity, "LMS_ATTEMPTS_RESET", "lms_enrollment", enrollmentId, { lessonId, voided: result.rowCount });
      return { voided: result.rowCount };
    });
  }

  analytics(identity: AuthIdentity) {
    if (!this.isHr(identity)) throw new ForbiddenException("Learning analytics are available to HR.");
    return this.database.tenantTransaction(identity, async (client) => {
      const courses = (await client.query(
        `SELECT c.id, c.title, c.category, c.mandatory, c.status, c.cover_emoji AS "coverEmoji", c.cover_color AS "coverColor", tm.full_name AS "teamManager",
                count(e.id)::int AS enrollments,
                count(e.id) FILTER (WHERE e.status='COMPLETED')::int AS completed,
                count(e.id) FILTER (WHERE e.status='IN_PROGRESS')::int AS "inProgress",
                count(e.id) FILTER (WHERE e.status='NOT_STARTED')::int AS "notStarted",
                count(e.id) FILTER (WHERE e.status<>'COMPLETED' AND e.due_date < current_date)::int AS overdue,
                (SELECT round(avg(best))::int FROM (
                   SELECT max(q.score) AS best FROM lms_quiz_attempts q JOIN lms_enrollments qe ON qe.id=q.enrollment_id AND qe.organization_id=q.organization_id
                    WHERE q.organization_id=c.organization_id AND qe.course_id=c.id AND q.voided_at IS NULL GROUP BY q.enrollment_id, q.lesson_id) s) AS "avgQuizScore"
           FROM lms_courses c
           LEFT JOIN employees tm ON tm.id=c.team_manager_id AND tm.organization_id=c.organization_id
           LEFT JOIN lms_enrollments e ON e.course_id=c.id AND e.organization_id=c.organization_id
          WHERE c.organization_id=$1 AND c.status<>'DRAFT'
          GROUP BY c.id, tm.full_name ORDER BY c.mandatory DESC, count(e.id) DESC, c.title`, [identity.organizationId])).rows
        .map((row) => ({ ...row, completionRate: row.enrollments ? Math.round((row.completed / row.enrollments) * 100) : 0 }));
      const overdueCompliance = (await client.query(
        `SELECT e.id, m.full_name AS name, m.employee_number AS "employeeNumber", m.department, m.location, mg.full_name AS manager,
                c.title AS course, c.id AS "courseId", to_char(e.due_date,'YYYY-MM-DD') AS "dueDate", e.progress_pct AS "progressPct", (current_date - e.due_date) AS "daysOverdue"
           FROM lms_enrollments e JOIN lms_courses c ON c.id=e.course_id AND c.organization_id=e.organization_id
           JOIN employees m ON m.id=e.employee_id AND m.organization_id=e.organization_id
           LEFT JOIN employees mg ON mg.id=m.manager_id AND mg.organization_id=m.organization_id
          WHERE e.organization_id=$1 AND c.mandatory AND c.status='PUBLISHED' AND e.status<>'COMPLETED' AND e.due_date < current_date AND m.status='ACTIVE'
          ORDER BY e.due_date, m.full_name LIMIT 200`, [identity.organizationId])).rows;
      const totals = (await client.query(
        `SELECT count(*)::int AS enrollments, count(*) FILTER (WHERE e.status='COMPLETED')::int AS completed,
                count(DISTINCT e.employee_id)::int AS learners,
                (SELECT count(*)::int FROM lms_certificates WHERE organization_id=$1) AS certificates,
                (SELECT coalesce(sum(l.duration_minutes),0)::int FROM lms_lesson_progress p JOIN lms_lessons l ON l.id=p.lesson_id AND l.organization_id=p.organization_id WHERE p.organization_id=$1) AS minutes,
                (SELECT count(*)::int FROM lms_enrollments me JOIN lms_courses mc ON mc.id=me.course_id AND mc.organization_id=me.organization_id
                  WHERE me.organization_id=$1 AND mc.mandatory AND mc.status='PUBLISHED') AS "mandatoryEnrollments",
                (SELECT count(*)::int FROM lms_enrollments me JOIN lms_courses mc ON mc.id=me.course_id AND mc.organization_id=me.organization_id
                  WHERE me.organization_id=$1 AND mc.mandatory AND mc.status='PUBLISHED' AND me.status='COMPLETED') AS "mandatoryCompleted"
           FROM lms_enrollments e JOIN lms_courses c ON c.id=e.course_id AND c.organization_id=e.organization_id
          WHERE e.organization_id=$1 AND c.status<>'DRAFT'`, [identity.organizationId])).rows[0];
      const activeEmployees = Number((await client.query(`SELECT count(*) FROM employees WHERE organization_id=$1 AND status='ACTIVE'`, [identity.organizationId])).rows[0].count);
      const monthly = (await client.query(
        `SELECT to_char(date_trunc('month', e.completed_at),'YYYY-MM') AS month, count(*)::int AS completions
           FROM lms_enrollments e WHERE e.organization_id=$1 AND e.completed_at >= date_trunc('month', now()) - interval '5 months'
          GROUP BY 1 ORDER BY 1`, [identity.organizationId])).rows;
      return {
        courses, overdueCompliance, monthly,
        totals: {
          ...totals, activeEmployees,
          completionRate: totals.enrollments ? Math.round((totals.completed / totals.enrollments) * 100) : 0,
          complianceRate: totals.mandatoryEnrollments ? Math.round((totals.mandatoryCompleted / totals.mandatoryEnrollments) * 100) : 100,
          overdueCompliance: overdueCompliance.length,
        },
      };
    });
  }

  /** One row per enrolment. HR sees everyone; managers export their direct reports. */
  exportCsv(identity: AuthIdentity, scope: "all" | "team") {
    if (scope === "all" && !this.isHr(identity)) throw new ForbiddenException("Only HR can export company-wide learning records.");
    return this.database.tenantTransaction(identity, async (client) => {
      const me = await this.me(client, identity);
      const rows = (await client.query(
        `SELECT m.employee_number, m.full_name, m.department, m.location, mg.full_name AS manager, c.title, c.category, c.mandatory, e.source, e.status,
                e.progress_pct, to_char(e.due_date,'YYYY-MM-DD') AS due_date, (e.due_date IS NOT NULL AND e.status<>'COMPLETED' AND e.due_date < current_date) AS overdue,
                to_char(e.started_at,'YYYY-MM-DD') AS started, to_char(e.completed_at,'YYYY-MM-DD') AS completed,
                (SELECT max(q.score) FROM lms_quiz_attempts q WHERE q.enrollment_id=e.id AND q.organization_id=e.organization_id AND q.voided_at IS NULL) AS best_score,
                cert.verification_code
           FROM lms_enrollments e JOIN lms_courses c ON c.id=e.course_id AND c.organization_id=e.organization_id
           JOIN employees m ON m.id=e.employee_id AND m.organization_id=e.organization_id
           LEFT JOIN employees mg ON mg.id=m.manager_id AND mg.organization_id=m.organization_id
           LEFT JOIN lms_certificates cert ON cert.enrollment_id=e.id AND cert.organization_id=e.organization_id
          WHERE e.organization_id=$1 AND c.status<>'DRAFT' AND ($2 OR m.manager_id=$3)
          ORDER BY c.title, m.full_name`, [identity.organizationId, scope === "all", me.id])).rows;
      const header = ["Employee ID", "Name", "Department", "Location", "Manager", "Course", "Category", "Mandatory", "Source", "Status", "Progress %", "Due date", "Overdue", "Started", "Completed", "Best quiz score", "Certificate"];
      const lines = [header, ...rows.map((row) => [row.employee_number, row.full_name, row.department, row.location, row.manager, row.title, row.category,
        row.mandatory ? "Yes" : "No", row.source, row.status, row.progress_pct, row.due_date, row.overdue ? "Yes" : "No", row.started, row.completed, row.best_score, row.verification_code])];
      await this.audit(client, identity, "LMS_EXPORTED", "employee", me.id, { scope, rows: rows.length });
      return lines.map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
    });
  }

  // ---- helpers ------------------------------------------------------------------------------------

  private isHr(identity: AuthIdentity) { return identity.roles.some((role) => HR_ROLES.includes(role)); }
  private isManager(identity: AuthIdentity) { return identity.roles.includes("MANAGER"); }
  private requireAuthor(identity: AuthIdentity) {
    if (!this.isHr(identity) && !this.isManager(identity)) throw new ForbiddenException("Only HR and managers can manage courses.");
  }
  private canManage(identity: AuthIdentity, course: Row) {
    if (this.isHr(identity)) return true;
    return this.isManager(identity) && course.team_manager_id === identity.employeeId && course.author_id === identity.employeeId;
  }

  private async me(client: PoolClient, identity: AuthIdentity): Promise<Me> {
    const row = (await client.query(`SELECT id, full_name, manager_id, department, location FROM employees WHERE organization_id=$1 AND id=$2`,
      [identity.organizationId, identity.employeeId])).rows[0];
    if (!row) throw new NotFoundException("Your employee profile was not found.");
    return row;
  }

  private async findCourse(client: PoolClient, identity: AuthIdentity, id: string, lock = false) {
    if (!UUID.test(id)) return null;
    return (await client.query(`SELECT ${COURSE_COLUMNS} ${COURSE_FROM} WHERE c.organization_id=$1 AND c.id=$2${lock ? " FOR UPDATE OF c" : ""}`, [identity.organizationId, id])).rows[0] || null;
  }

  private async canView(client: PoolClient, identity: AuthIdentity, me: Me, course: Row) {
    if (this.canManage(identity, course)) return true;
    const enrolled = (await client.query(`SELECT 1 FROM lms_enrollments WHERE organization_id=$1 AND course_id=$2 AND employee_id=$3`, [identity.organizationId, course.id, me.id])).rowCount;
    if (enrolled && course.status !== "DRAFT") return true;
    return course.status === "PUBLISHED" && (!course.team_manager_id || course.team_manager_id === me.manager_id || course.team_manager_id === me.id);
  }

  private async requireCourse(client: PoolClient, identity: AuthIdentity, me: Me, id: string) {
    const course = await this.findCourse(client, identity, id);
    if (!course || !(await this.canView(client, identity, me, course))) throw new NotFoundException("Course not found.");
    return course;
  }

  private async manageable(client: PoolClient, identity: AuthIdentity, id: string, lock = false) {
    this.requireAuthor(identity);
    const course = await this.findCourse(client, identity, id, lock);
    if (!course) throw new NotFoundException("Course not found.");
    if (!this.canManage(identity, course)) throw new ForbiddenException("You can only edit courses you manage.");
    return course;
  }

  private checkVersion(course: Row, version: number) {
    if (course.version !== version) throw new ConflictException("This course changed since you opened it. Refresh and try again.");
  }

  private async requireLesson(client: PoolClient, identity: AuthIdentity, courseId: string, lessonId: string) {
    if (!UUID.test(lessonId)) throw new NotFoundException("Lesson not found.");
    const lesson = (await client.query(`SELECT * FROM lms_lessons WHERE organization_id=$1 AND course_id=$2 AND id=$3 AND deleted_at IS NULL`,
      [identity.organizationId, courseId, lessonId])).rows[0];
    if (!lesson) throw new NotFoundException("Lesson not found.");
    return lesson;
  }

  private async enrollmentFor(client: PoolClient, identity: AuthIdentity, courseId: string, employeeId: string) {
    return (await client.query(
      `SELECT ${ENROLLMENT_COLUMNS} FROM lms_enrollments e ${ENROLLMENT_JOINS} WHERE e.organization_id=$1 AND e.course_id=$2 AND e.employee_id=$3`,
      [identity.organizationId, courseId, employeeId])).rows[0] || null;
  }

  private async lockEnrollment(client: PoolClient, identity: AuthIdentity, courseId: string, employeeId: string) {
    const row = (await client.query(`SELECT id, status FROM lms_enrollments WHERE organization_id=$1 AND course_id=$2 AND employee_id=$3 FOR UPDATE`,
      [identity.organizationId, courseId, employeeId])).rows[0];
    if (!row) throw new ForbiddenException("Enrol in this course first.");
    return row;
  }

  private async attemptSummary(client: PoolClient, identity: AuthIdentity, enrollmentId: string, lesson: Row) {
    const row = (await client.query(
      `SELECT count(*)::int AS used, max(score) AS best, bool_or(passed) AS passed FROM lms_quiz_attempts
        WHERE organization_id=$1 AND enrollment_id=$2 AND lesson_id=$3 AND voided_at IS NULL`, [identity.organizationId, enrollmentId, lesson.id])).rows[0];
    const max = lesson.max_attempts || null;
    const passed = !!row.passed;
    return { attemptsUsed: row.used, attemptsLeft: max ? Math.max(0, max - row.used) : null, bestScore: row.best, passed, locked: !passed && !!max && row.used >= max };
  }

  /** Recalculate progress; issue the certificate the moment every lesson is done (quizzes count once passed). */
  private async recompute(client: PoolClient, identity: AuthIdentity, enrollmentId: string) {
    const row = (await client.query(
      `SELECT e.id, e.status, e.course_id, e.employee_id, c.title, c.version, m.full_name, m.manager_id,
              (SELECT count(*)::int FROM lms_lessons l WHERE l.organization_id=e.organization_id AND l.course_id=e.course_id AND l.deleted_at IS NULL) AS total,
              (SELECT count(*)::int FROM lms_lesson_progress p JOIN lms_lessons l ON l.id=p.lesson_id AND l.deleted_at IS NULL
                WHERE p.organization_id=e.organization_id AND p.enrollment_id=e.id) AS done
         FROM lms_enrollments e JOIN lms_courses c ON c.id=e.course_id AND c.organization_id=e.organization_id
         JOIN employees m ON m.id=e.employee_id AND m.organization_id=e.organization_id
        WHERE e.organization_id=$1 AND e.id=$2`, [identity.organizationId, enrollmentId])).rows[0];
    if (row.status === "COMPLETED") return this.enrollmentState(client, identity, enrollmentId, false);
    const pct = row.total ? Math.min(100, Math.round((row.done / row.total) * 100)) : 0;
    const complete = row.total > 0 && row.done >= row.total;
    const status = complete ? "COMPLETED" : row.done || row.status === "IN_PROGRESS" ? "IN_PROGRESS" : row.status;
    await client.query(
      `UPDATE lms_enrollments SET progress_pct=$3, status=$4, started_at=CASE WHEN $4='NOT_STARTED' THEN started_at ELSE coalesce(started_at,now()) END,
              completed_at=CASE WHEN $4='COMPLETED' THEN now() ELSE NULL END, updated_at=now()
        WHERE organization_id=$1 AND id=$2`, [identity.organizationId, enrollmentId, pct, status]);
    if (!complete) return this.enrollmentState(client, identity, enrollmentId, false);
    const score = (await client.query(
      `SELECT round(avg(best))::int AS score FROM (SELECT max(score) AS best FROM lms_quiz_attempts WHERE organization_id=$1 AND enrollment_id=$2 AND voided_at IS NULL AND passed GROUP BY lesson_id) s`,
      [identity.organizationId, enrollmentId])).rows[0].score;
    let certificate: Row | undefined;
    for (let tries = 0; tries < 5 && !certificate; tries += 1) {
      certificate = (await client.query(
        `INSERT INTO lms_certificates(organization_id,enrollment_id,course_id,employee_id,verification_code,course_title,employee_name,course_version,score)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id, verification_code`,
        [identity.organizationId, enrollmentId, row.course_id, row.employee_id, certificateCode(), row.title, row.full_name, row.version, score])).rows[0];
      if (!certificate && (await client.query(`SELECT 1 FROM lms_certificates WHERE enrollment_id=$1`, [enrollmentId])).rowCount) break;
    }
    await this.audit(client, identity, "LMS_COURSE_COMPLETED", "lms_enrollment", enrollmentId, { courseId: row.course_id, certificate: certificate?.verification_code, score });
    await this.notify(client, identity, row.employee_id, "LMS_COMPLETED", enrollmentId, {
      courseId: row.course_id, courseTitle: row.title, certificateId: certificate?.id, href: certificate ? `/learning/certificates/${certificate.id}` : `/learning/course/${row.course_id}`,
      message: `You completed “${row.title}” — your certificate is ready`,
    });
    if (row.manager_id) await this.notify(client, identity, row.manager_id, "LMS_TEAM_COMPLETED", enrollmentId, {
      courseId: row.course_id, courseTitle: row.title, employee: row.full_name, href: "/learning?tab=team", message: `${row.full_name} completed “${row.title}”`,
    });
    return this.enrollmentState(client, identity, enrollmentId, true);
  }

  private async enrollmentState(client: PoolClient, identity: AuthIdentity, enrollmentId: string, justCompleted: boolean) {
    const row = (await client.query(`SELECT ${ENROLLMENT_COLUMNS} FROM lms_enrollments e ${ENROLLMENT_JOINS} WHERE e.organization_id=$1 AND e.id=$2`,
      [identity.organizationId, enrollmentId])).rows[0];
    return { ...this.presentEnrollment(row)!, justCompleted };
  }

  /** New joiners (and anyone missed) pick up every published mandatory course the first time they open Learning. */
  private async ensureMandatory(client: PoolClient, identity: AuthIdentity, employeeId: string) {
    await client.query(
      `INSERT INTO lms_enrollments(organization_id,course_id,employee_id,source,due_date)
       SELECT c.organization_id, c.id, $2, 'MANDATORY', current_date + c.mandatory_due_days FROM lms_courses c
        WHERE c.organization_id=$1 AND c.mandatory AND c.status='PUBLISHED' AND c.team_manager_id IS NULL
          AND EXISTS (SELECT 1 FROM employees x WHERE x.organization_id=$1 AND x.id=$2 AND x.status='ACTIVE')
       ON CONFLICT (organization_id,course_id,employee_id) DO NOTHING`, [identity.organizationId, employeeId]);
  }

  private async applyMandatory(client: PoolClient, identity: AuthIdentity, courseId: string) {
    const course = (await client.query(`SELECT id, title, mandatory_due_days FROM lms_courses WHERE organization_id=$1 AND id=$2`, [identity.organizationId, courseId])).rows[0];
    const rows = (await client.query(
      `INSERT INTO lms_enrollments(organization_id,course_id,employee_id,source,due_date,assigned_by)
       SELECT $1, $2, m.id, 'MANDATORY', current_date + $3::int, $4 FROM employees m WHERE m.organization_id=$1 AND m.status='ACTIVE'
       ON CONFLICT (organization_id,course_id,employee_id) DO UPDATE
         SET source='MANDATORY', due_date=coalesce(lms_enrollments.due_date, EXCLUDED.due_date), updated_at=now()
       WHERE lms_enrollments.status<>'COMPLETED' AND lms_enrollments.source<>'MANDATORY'
       RETURNING id, employee_id, to_char(due_date,'YYYY-MM-DD') AS due_date`,
      [identity.organizationId, courseId, course.mandatory_due_days, identity.employeeId])).rows;
    for (const row of rows) if (row.employee_id !== identity.employeeId) await this.notify(client, identity, row.employee_id, "LMS_ASSIGNED", row.id, {
      courseId, courseTitle: course.title, dueDate: row.due_date, mandatory: true, href: `/learning/course/${courseId}`,
      message: `Mandatory training: “${course.title}” · due ${formatDate(row.due_date)}`,
    });
    if (rows.length) await this.audit(client, identity, "LMS_MANDATORY_ENROLLED", "lms_course", courseId, { count: rows.length });
    return rows.length;
  }

  private async validateForPublish(client: PoolClient, identity: AuthIdentity, courseId: string) {
    const lessons = (await client.query(
      `SELECT l.id, l.title, l.type, l.video_url, (SELECT count(*)::int FROM lms_questions q WHERE q.lesson_id=l.id AND q.organization_id=l.organization_id) AS questions
         FROM lms_lessons l WHERE l.organization_id=$1 AND l.course_id=$2 AND l.deleted_at IS NULL`, [identity.organizationId, courseId])).rows;
    const problems: string[] = [];
    if (!lessons.length) problems.push("Add at least one lesson before publishing.");
    for (const lesson of lessons) {
      if (lesson.type === "QUIZ" && !lesson.questions) problems.push(`Quiz “${lesson.title}” has no questions.`);
      if (lesson.type === "VIDEO" && !lesson.video_url) problems.push(`Video lesson “${lesson.title}” needs a video link.`);
      if (lesson.type === "PDF" && !(await this.files.count(client, identity, "lms_lesson", lesson.id))) problems.push(`PDF lesson “${lesson.title}” has no document attached.`);
    }
    if (problems.length) throw new BadRequestException(problems);
  }

  private lessonFields(type: string, input: { body?: string; videoUrl?: string; durationMinutes?: number; passMark?: number; maxAttempts?: number }) {
    let videoUrl: string | null = null;
    if (type === "VIDEO") {
      const raw = String(input.videoUrl || "").trim();
      if (raw) {
        let parsed: URL;
        try { parsed = new URL(raw); } catch { throw new BadRequestException("The video link is not a valid URL."); }
        if (parsed.protocol !== "https:") throw new BadRequestException("Video links must start with https://.");
        if (parsed.username || parsed.password) throw new BadRequestException("Video links cannot contain credentials.");
        videoUrl = parsed.toString();
      }
    }
    return {
      body: String(input.body || "").replace(/\r\n/g, "\n"),
      videoUrl,
      durationMinutes: input.durationMinutes || (type === "QUIZ" ? 10 : 5),
      passMark: type === "QUIZ" ? input.passMark || DEFAULT_PASS_MARK : null,
      maxAttempts: type === "QUIZ" && input.maxAttempts ? input.maxAttempts : null,
    };
  }

  private async replaceQuestions(client: PoolClient, identity: AuthIdentity, lessonId: string, questions: QuestionDto[]) {
    const errors: string[] = [];
    questions.forEach((question, index) => {
      const ids = question.options.map((option) => option.id);
      if (new Set(ids).size !== ids.length) errors.push(`Question ${index + 1}: option ids must be unique.`);
      const correct = [...new Set(question.correct)];
      if (correct.some((id) => !ids.includes(id))) errors.push(`Question ${index + 1}: the correct answer must be one of its options.`);
      if (question.kind === "SINGLE" && correct.length !== 1) errors.push(`Question ${index + 1}: single-choice questions need exactly one correct answer.`);
    });
    if (errors.length) throw new BadRequestException(errors);
    await client.query(`DELETE FROM lms_questions WHERE organization_id=$1 AND lesson_id=$2`, [identity.organizationId, lessonId]);
    for (const [index, question] of questions.entries())
      await client.query(
        `INSERT INTO lms_questions(organization_id,lesson_id,position,prompt,kind,options,correct,explanation) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [identity.organizationId, lessonId, index, question.prompt.trim(), question.kind,
          JSON.stringify(question.options.map((option) => ({ id: option.id, text: option.text.trim() }))),
          JSON.stringify([...new Set(question.correct)]), (question.explanation || "").trim()]);
  }

  private touchCourse(client: PoolClient, identity: AuthIdentity, courseId: string) {
    return client.query(`UPDATE lms_courses SET version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`, [identity.organizationId, courseId]);
  }

  private async builderView(client: PoolClient, identity: AuthIdentity, courseId: string) {
    const course = await this.findCourse(client, identity, courseId);
    const lessons = (await client.query(
      `SELECT l.id, l.title, l.type, l.body, l.video_url AS "videoUrl", l.duration_minutes AS "durationMinutes", l.pass_mark AS "passMark",
              l.max_attempts AS "maxAttempts", l.position,
              (SELECT count(*)::int FROM stored_files f WHERE f.organization_id=l.organization_id AND f.entity_type='lms_lesson' AND f.entity_id=l.id AND f.deleted_at IS NULL) AS files,
              coalesce((SELECT json_agg(json_build_object('id',q.id,'prompt',q.prompt,'kind',q.kind,'options',q.options,'correct',q.correct,'explanation',q.explanation) ORDER BY q.position)
                 FROM lms_questions q WHERE q.organization_id=l.organization_id AND q.lesson_id=l.id), '[]'::json) AS questions
         FROM lms_lessons l WHERE l.organization_id=$1 AND l.course_id=$2 AND l.deleted_at IS NULL ORDER BY l.position, l.created_at`,
      [identity.organizationId, courseId])).rows.map((lesson) => ({ ...lesson, embedUrl: lesson.videoUrl ? videoEmbed(lesson.videoUrl) : null }));
    return { ...this.presentCourse(course), mandatoryDueDays: course.mandatory_due_days, lessons, canManage: true };
  }

  private presentEnrollment(row: Row) {
    if (!row?.e_id) return null;
    return {
      id: row.e_id, status: row.e_status, progressPct: row.e_progress, dueDate: row.e_due, source: row.e_source, lastLessonId: row.e_last_lesson,
      startedAt: row.e_started, completedAt: row.e_completed, enrolledAt: row.e_created, overdue: !!row.e_overdue, dueSoon: !!row.e_due_soon,
      assignedBy: row.e_assigned_by || null, certificateId: row.e_certificate_id || null, certificateCode: row.e_certificate_code || null,
    };
  }

  private presentCourse(row: Row) {
    return {
      id: row.id, title: row.title, summary: row.summary, description: row.description, category: row.category, level: row.level,
      durationMinutes: row.duration_minutes, coverColor: row.cover_color, coverEmoji: row.cover_emoji, mandatory: row.mandatory, status: row.status,
      version: row.version, publishedAt: row.published_at, updatedAt: row.updated_at, lessonCount: row.lesson_count, learnerCount: row.learner_count,
      author: row.author_name, teamCourse: !!row.team_manager_id, teamManager: row.team_manager_name || null,
      enrollment: this.presentEnrollment(row),
    };
  }

  private notify(client: PoolClient, identity: AuthIdentity, employeeId: string, eventType: string, entityId: string, payload: Record<string, unknown>) {
    return client.query(`INSERT INTO workflow_events(organization_id,employee_id,event_type,entity_type,entity_id,payload) VALUES($1,$2,$3,'lms_enrollment',$4,$5)`,
      [identity.organizationId, employeeId, eventType, entityId, JSON.stringify(payload)]);
  }

  private audit(client: PoolClient, identity: AuthIdentity, action: string, entityType: string, entityId: string, after: unknown, before?: unknown) {
    return client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [identity.organizationId, identity.userId, action, entityType, entityId, before === undefined ? null : JSON.stringify(before), JSON.stringify(after)]);
  }
}

/** Privacy-friendly embeds only: youtube-nocookie and Vimeo with do-not-track. Anything else is shown as a plain link. */
export function videoEmbed(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.replace(/^www\.|^m\./, "");
  const id = (value: string | null | undefined) => (value && /^[A-Za-z0-9_-]{6,20}$/.test(value) ? value : null);
  let youtube: string | null = null;
  if (host === "youtu.be") youtube = id(parsed.pathname.split("/")[1]);
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    youtube = parts[0] === "watch" ? id(parsed.searchParams.get("v")) : ["embed", "shorts", "live"].includes(parts[0]) ? id(parts[1]) : null;
  }
  if (youtube) return `https://www.youtube-nocookie.com/embed/${youtube}?rel=0&modestbranding=1`;
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const match = /(?:^|\/)(\d{6,12})(?:$|\/)/.exec(parsed.pathname);
    if (match) return `https://player.vimeo.com/video/${match[1]}?dnt=1`;
  }
  return null;
}

function certificateCode() {
  const block = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  return `NS-${block()}-${block()}`;
}

function addDays(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function formatDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function pick(row: Row, keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}

/** Quote every cell and neutralise spreadsheet formulas. */
function csvCell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
