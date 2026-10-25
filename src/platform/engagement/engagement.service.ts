import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import type {
  AnswerDto, AudienceType, CreatePollDto, ListSurveysQuery, QuestionDto, QuestionType, ResultsQuery, SubmitResponseDto, SurveyInputDto, UpdateSurveyDto, VoteDto,
} from "./engagement.dto";

type Row = Record<string, any>;
const HR_ROLES = ["HR_ADMIN", "OWNER"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHOICE_TYPES: QuestionType[] = ["SINGLE_CHOICE", "MULTI_CHOICE"];
const TEXT_LIMIT: Record<string, number> = { SHORT_TEXT: 280, LONG_TEXT: 4000 };
export const DEFAULT_SCALE: Record<string, string[]> = {
  RATING: ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"],
  ENPS: ["Not at all likely", "Extremely likely"],
};
/** Reminders to the same person are throttled so HR cannot spam non-respondents. */
const REMINDER_COOLDOWN_HOURS = 20;

const SELECT_SURVEY = `
  SELECT s.*, o.full_name AS owner_name, o.designation AS owner_designation,
         (SELECT count(*)::int FROM survey_questions q WHERE q.survey_id=s.id) AS question_count,
         (SELECT count(*)::int FROM survey_invitations i WHERE i.survey_id=s.id) AS invited,
         (SELECT count(*)::int FROM survey_invitations i WHERE i.survey_id=s.id AND i.responded_on IS NOT NULL) AS responded,
         mi.employee_id IS NOT NULL AS me_invited, to_char(mi.responded_on,'YYYY-MM-DD') AS me_responded_on
    FROM surveys s
    JOIN employees o ON o.id=s.owner_id AND o.organization_id=s.organization_id
    LEFT JOIN survey_invitations mi ON mi.survey_id=s.id AND mi.employee_id=$2`;

@Injectable()
export class EngagementService {
  constructor(private readonly database: DatabaseService) {}

  // ---- reads -------------------------------------------------------------------------------------

  /** Everything the signed-in employee needs on /surveys: pending, completed and whether they can build surveys. */
  home(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      await this.sweep(client, identity);
      const rows = (await client.query(
        `${SELECT_SURVEY} WHERE s.organization_id=$1 AND s.kind='SURVEY' AND s.status<>'DRAFT' AND mi.employee_id IS NOT NULL
          ORDER BY s.closes_at NULLS LAST, s.launched_at DESC LIMIT 200`, [identity.organizationId, identity.employeeId])).rows;
      const items = rows.map((row) => this.present(identity, row));
      const reports = await this.directReports(client, identity);
      return {
        viewer: this.viewer(identity, reports),
        pending: items.filter((item) => item.me.canRespond && !item.me.respondedOn),
        editable: items.filter((item) => item.me.canRespond && item.me.respondedOn),
        upcoming: items.filter((item) => item.state === "SCHEDULED"),
        completed: items.filter((item) => item.me.respondedOn && !item.me.canRespond),
        missed: items.filter((item) => item.state === "CLOSED" && !item.me.respondedOn),
      };
    });
  }

  list(identity: AuthIdentity, query: ListSurveysQuery) {
    return this.database.tenantTransaction(identity, async (client) => {
      await this.sweep(client, identity);
      const reports = await this.directReports(client, identity);
      if (!this.isHr(identity) && !reports) throw new ForbiddenException("Only HR and people managers can manage surveys.");
      const values: unknown[] = [identity.organizationId, identity.employeeId, query.kind || "SURVEY"];
      const scope = this.isHr(identity) ? "" : " AND s.owner_id=$2";
      const rows = (await client.query(`${SELECT_SURVEY} WHERE s.organization_id=$1 AND s.kind=$3${scope} ORDER BY
          CASE s.status WHEN 'LIVE' THEN 0 WHEN 'DRAFT' THEN 1 ELSE 2 END, s.updated_at DESC LIMIT 300`, values)).rows;
      return { items: rows.map((row) => this.present(identity, row)), viewer: this.viewer(identity, reports) };
    });
  }

  /** Departments, locations and team size for the audience picker. */
  options(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const reports = await this.directReports(client, identity);
      if (!this.isHr(identity) && !reports) throw new ForbiddenException("Only HR and people managers can build surveys.");
      const group = async (column: "department" | "location") => (await client.query(
        `SELECT ${column} AS name, count(*)::int AS count FROM employees WHERE organization_id=$1 AND status='ACTIVE' AND coalesce(${column},'')<>''
          GROUP BY ${column} ORDER BY ${column}`, [identity.organizationId])).rows;
      const total = (await client.query(`SELECT count(*)::int AS n FROM employees WHERE organization_id=$1 AND status='ACTIVE'`, [identity.organizationId])).rows[0].n;
      return {
        viewer: this.viewer(identity, reports),
        departments: this.isHr(identity) ? await group("department") : [],
        locations: this.isHr(identity) ? await group("location") : [],
        total: this.isHr(identity) ? total : 0, teamSize: reports,
        audienceTypes: this.isHr(identity) ? ["ALL", "DEPARTMENTS", "LOCATIONS", ...(reports ? ["TEAM"] : [])] : ["TEAM"],
        defaults: DEFAULT_SCALE, minGroupSize: 3,
      };
    });
  }

  get(identity: AuthIdentity, id: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      await this.sweep(client, identity);
      const row = await this.load(client, identity, id);
      const survey = this.present(identity, row);
      const questions = await this.questions(client, identity, id);
      // Identified, editable responses are returned so the employee can revise them. Anonymous answers are never linkable.
      let myAnswers: Record<string, unknown> | null = null;
      if (!row.anonymous && row.me_responded_on) {
        const answers = (await client.query(
          `SELECT a.question_id, a.numeric_value, a.choice_values, a.text_value FROM survey_answers a
             JOIN survey_responses r ON r.id=a.response_id AND r.organization_id=a.organization_id
            WHERE a.organization_id=$1 AND r.survey_id=$2 AND r.employee_id=$3`, [identity.organizationId, id, identity.employeeId])).rows;
        myAnswers = Object.fromEntries(answers.map((answer) => [answer.question_id, this.answerValue(answer)]));
      }
      return { ...survey, questions, myAnswers };
    });
  }

  // ---- authoring ---------------------------------------------------------------------------------

  async create(identity: AuthIdentity, input: SurveyInputDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const reports = await this.directReports(client, identity);
      this.checkAudience(identity, reports, input.audienceType, input.audienceValues);
      const dates = this.checkDates(input.opensAt, input.closesAt);
      this.checkSettings(input.anonymous, input.allowEdit);
      const questions = this.normaliseQuestions(input.questions);
      const row = (await client.query(
        `INSERT INTO surveys(organization_id,kind,title,description,anonymous,allow_edit,share_results,audience_type,audience_values,owner_id,opens_at,closes_at)
         VALUES($1,'SURVEY',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [identity.organizationId, input.title.trim(), input.description?.trim() || null, input.anonymous, input.allowEdit, input.shareResults,
          input.audienceType, this.cleanList(input.audienceValues), identity.employeeId, dates.opensAt, dates.closesAt])).rows[0];
      await this.writeQuestions(client, identity, row.id, questions);
      await this.audit(client, identity, "SURVEY_CREATED", row.id, null, { title: input.title, questions: questions.length, audience: input.audienceType });
      return this.present(identity, await this.load(client, identity, row.id));
    });
  }

  update(identity: AuthIdentity, id: string, input: UpdateSurveyDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      await this.sweep(client, identity);
      const row = await this.load(client, identity, id, true);
      this.requireManage(identity, row);
      if (row.version !== input.version) throw new ConflictException("This survey changed since you opened it. Refresh and try again.");
      if (row.status === "CLOSED") throw new ConflictException("Closed surveys can no longer be edited. Duplicate it to run it again.");
      const before = this.present(identity, row);
      if (row.status === "LIVE") {
        const locked = (["title", "anonymous", "allowEdit", "audienceType", "audienceValues", "opensAt", "questions"] as const)
          .filter((key) => input[key] !== undefined);
        if (locked.length) throw new ConflictException("Questions, audience and privacy settings are locked once a survey is live. You can still extend the close date or change the description.");
        const closesAt = input.closesAt === undefined ? row.closes_at : this.checkDates(null, input.closesAt).closesAt;
        await client.query(`UPDATE surveys SET description=$3, closes_at=$4, share_results=$5, version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`,
          [identity.organizationId, id, input.description === undefined ? row.description : input.description.trim() || null, closesAt, input.shareResults ?? row.share_results]);
      } else {
        const reports = await this.directReports(client, identity);
        const audienceType = input.audienceType ?? row.audience_type;
        const audienceValues = input.audienceValues ?? row.audience_values;
        this.checkAudience(identity, reports, audienceType, audienceValues, row.owner_id);
        const anonymous = input.anonymous ?? row.anonymous;
        const allowEdit = input.allowEdit ?? row.allow_edit;
        this.checkSettings(anonymous, allowEdit);
        const dates = this.checkDates(input.opensAt === undefined ? row.opens_at : input.opensAt, input.closesAt === undefined ? row.closes_at : input.closesAt);
        await client.query(
          `UPDATE surveys SET title=$3, description=$4, anonymous=$5, allow_edit=$6, share_results=$7, audience_type=$8, audience_values=$9,
                  opens_at=$10, closes_at=$11, version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`,
          [identity.organizationId, id, input.title?.trim() ?? row.title, input.description === undefined ? row.description : input.description.trim() || null,
            anonymous, allowEdit, input.shareResults ?? row.share_results, audienceType, this.cleanList(audienceValues), dates.opensAt, dates.closesAt]);
        if (input.questions) {
          const questions = this.normaliseQuestions(input.questions);
          await client.query(`DELETE FROM survey_questions WHERE organization_id=$1 AND survey_id=$2`, [identity.organizationId, id]);
          await this.writeQuestions(client, identity, id, questions);
        }
      }
      const after = this.present(identity, await this.load(client, identity, id));
      await this.audit(client, identity, "SURVEY_UPDATED", id, before, after);
      return after;
    });
  }

  launch(identity: AuthIdentity, id: string, version: number) {
    return this.database.tenantTransaction(identity, async (client) => {
      const row = await this.load(client, identity, id, true);
      this.requireManage(identity, row);
      if (row.version !== version) throw new ConflictException("This survey changed since you opened it. Refresh and try again.");
      if (row.status !== "DRAFT") throw new ConflictException("Only draft surveys can be launched.");
      const questions = await this.questions(client, identity, id);
      if (!questions.length) throw new BadRequestException("Add at least one question before launching.");
      if (row.closes_at && new Date(row.closes_at).getTime() <= Date.now()) throw new BadRequestException("The close date is in the past. Pick a later date.");
      const reports = await this.directReports(client, identity);
      this.checkAudience(identity, reports, row.audience_type, row.audience_values, row.owner_id);
      const audience = await this.resolveAudience(client, identity, row.audience_type, row.audience_values, row.owner_id);
      if (!audience.length) throw new BadRequestException("Nobody matches this audience yet.");
      if (row.anonymous && audience.length < row.min_group_size)
        throw new BadRequestException(`Anonymous surveys need an audience of at least ${row.min_group_size} people, otherwise results could never be shown safely.`);
      await this.invite(client, identity, id, audience);
      const updated = (await client.query(
        `UPDATE surveys SET status='LIVE', launched_at=now(), opens_at=coalesce(opens_at, now()), version=version+1, updated_at=now()
          WHERE organization_id=$1 AND id=$2 RETURNING opens_at, closes_at`, [identity.organizationId, id])).rows[0];
      const scheduled = new Date(updated.opens_at).getTime() > Date.now();
      const closing = updated.closes_at ? ` · closes ${formatDay(updated.closes_at)}` : "";
      await this.notifyMany(client, identity, audience, "SURVEY_LIVE", id, {
        title: row.title, anonymous: row.anonymous, href: `/surveys/${id}`, closesAt: updated.closes_at, opensAt: updated.opens_at,
        message: `${scheduled ? `Survey opening ${formatDay(updated.opens_at)}` : "New survey"}: ${row.title}${row.anonymous ? " (anonymous)" : ""}${closing}`,
      });
      await this.audit(client, identity, "SURVEY_LAUNCHED", id, { status: "DRAFT" }, { status: "LIVE", invited: audience.length });
      return this.present(identity, await this.load(client, identity, id));
    });
  }

  close(identity: AuthIdentity, id: string, version: number) {
    return this.database.tenantTransaction(identity, async (client) => {
      const row = await this.load(client, identity, id, true);
      this.requireManage(identity, row);
      if (row.version !== version) throw new ConflictException("This survey changed since you opened it. Refresh and try again.");
      if (row.status !== "LIVE") throw new ConflictException("Only live surveys can be closed.");
      await client.query(`UPDATE surveys SET status='CLOSED', closed_at=now(), closes_at=LEAST(coalesce(closes_at, now()), now()), version=version+1, updated_at=now()
        WHERE organization_id=$1 AND id=$2`, [identity.organizationId, id]);
      await this.audit(client, identity, row.kind === "POLL" ? "POLL_CLOSED" : "SURVEY_CLOSED", id, { status: "LIVE" }, { status: "CLOSED" });
      return this.present(identity, await this.load(client, identity, id));
    });
  }

  remove(identity: AuthIdentity, id: string, version: number) {
    return this.database.tenantTransaction(identity, async (client) => {
      const row = await this.load(client, identity, id, true);
      this.requireManage(identity, row);
      if (row.version !== version) throw new ConflictException("This survey changed since you opened it. Refresh and try again.");
      if (row.status !== "DRAFT") throw new ConflictException("Only drafts can be deleted. Close a live survey instead.");
      await client.query(`DELETE FROM surveys WHERE organization_id=$1 AND id=$2`, [identity.organizationId, id]);
      await this.audit(client, identity, "SURVEY_DELETED", id, { title: row.title }, null);
      return { id, deleted: true };
    });
  }

  duplicate(identity: AuthIdentity, id: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const row = await this.load(client, identity, id);
      this.requireManage(identity, row);
      if (row.kind !== "SURVEY") throw new BadRequestException("Only surveys can be duplicated.");
      const reports = await this.directReports(client, identity);
      // A manager copying an HR survey may only run it for their own team.
      const teamOnly = !this.isHr(identity);
      if (teamOnly && !reports) throw new ForbiddenException("You have no direct reports to survey.");
      const copy = (await client.query(
        `INSERT INTO surveys(organization_id,kind,title,description,anonymous,allow_edit,share_results,audience_type,audience_values,owner_id)
         VALUES($1,'SURVEY',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [identity.organizationId, `${row.title.slice(0, 190)} (copy)`, row.description, row.anonymous, row.allow_edit, row.share_results,
          teamOnly ? "TEAM" : row.audience_type, teamOnly ? [] : row.audience_values, identity.employeeId])).rows[0];
      await client.query(
        `INSERT INTO survey_questions(organization_id,survey_id,position,type,prompt,help_text,required,options,scale_labels)
         SELECT organization_id,$3,position,type,prompt,help_text,required,options,scale_labels FROM survey_questions WHERE organization_id=$1 AND survey_id=$2`,
        [identity.organizationId, id, copy.id]);
      await this.audit(client, identity, "SURVEY_DUPLICATED", copy.id, null, { from: id });
      return this.present(identity, await this.load(client, identity, copy.id));
    });
  }

  /** Nudges invitees who have not answered yet. Only counts are returned, never names. */
  remind(identity: AuthIdentity, id: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      await this.sweep(client, identity);
      const row = await this.load(client, identity, id, true);
      this.requireManage(identity, row);
      if (row.status !== "LIVE") throw new ConflictException("Reminders can only be sent while a survey is live.");
      if (row.opens_at && new Date(row.opens_at).getTime() > Date.now()) throw new ConflictException("This survey has not opened yet.");
      const pending = (await client.query(
        `SELECT employee_id, (last_reminded_at IS NOT NULL AND last_reminded_at > now() - make_interval(hours => $3)) AS recent
           FROM survey_invitations WHERE organization_id=$1 AND survey_id=$2 AND responded_on IS NULL`,
        [identity.organizationId, id, REMINDER_COOLDOWN_HOURS])).rows;
      const due = pending.filter((item) => !item.recent).map((item) => item.employee_id as string);
      if (due.length) {
        await client.query(`UPDATE survey_invitations SET reminder_count=reminder_count+1, last_reminded_at=now()
          WHERE organization_id=$1 AND survey_id=$2 AND employee_id = ANY($3)`, [identity.organizationId, id, due]);
        await this.notifyMany(client, identity, due, "SURVEY_REMINDER", id, {
          title: row.title, href: `/surveys/${id}`, closesAt: row.closes_at,
          message: `Reminder: “${row.title}” is waiting for you${row.closes_at ? ` — closes ${formatDay(row.closes_at)}` : ""}${row.anonymous ? " (anonymous)" : ""}`,
        });
      }
      await this.audit(client, identity, "SURVEY_REMINDERS_SENT", id, null, { reminded: due.length, pending: pending.length });
      return { reminded: due.length, pending: pending.length, skippedRecent: pending.length - due.length, cooldownHours: REMINDER_COOLDOWN_HOURS };
    });
  }

  // ---- responding --------------------------------------------------------------------------------

  respond(identity: AuthIdentity, id: string, input: SubmitResponseDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      await this.sweep(client, identity);
      const row = await this.load(client, identity, id);
      if (row.kind !== "SURVEY") throw new BadRequestException("Use the poll vote endpoint for polls.");
      const questions = await this.questions(client, identity, id);
      const answers = this.validateAnswers(questions, input.answers);
      await this.saveResponse(client, identity, row, answers);
      return this.present(identity, await this.load(client, identity, id));
    });
  }

  private async saveResponse(client: PoolClient, identity: AuthIdentity, row: Row, answers: ValidAnswer[]) {
    const invitation = (await client.query(
      `SELECT responded_on FROM survey_invitations WHERE organization_id=$1 AND survey_id=$2 AND employee_id=$3 FOR UPDATE`,
      [identity.organizationId, row.id, identity.employeeId])).rows[0];
    const noun = row.kind === "POLL" ? "poll" : "survey";
    if (!invitation) throw new ForbiddenException(`You are not part of this ${noun}'s audience.`);
    const state = this.state(row);
    if (state === "SCHEDULED") throw new ConflictException(`This ${noun} opens on ${formatDay(row.opens_at)}.`);
    if (state !== "LIVE") throw new ConflictException(`This ${noun} is closed.`);
    const me = (await client.query(`SELECT department, location FROM employees WHERE organization_id=$1 AND id=$2`, [identity.organizationId, identity.employeeId])).rows[0] || {};
    let responseId: string;
    if (invitation.responded_on) {
      if (row.anonymous || !row.allow_edit) throw new ConflictException(row.kind === "POLL" ? "You have already voted." : "You have already responded to this survey.");
      responseId = (await client.query(`UPDATE survey_responses SET updated_at=now() WHERE organization_id=$1 AND survey_id=$2 AND employee_id=$3 RETURNING id`,
        [identity.organizationId, row.id, identity.employeeId])).rows[0].id;
      await client.query(`DELETE FROM survey_answers WHERE organization_id=$1 AND response_id=$2`, [identity.organizationId, responseId]);
    } else {
      // Anonymous: no employee id and no time of day. Only the (random) response id links answers together.
      responseId = (await client.query(
        row.anonymous
          ? `INSERT INTO survey_responses(organization_id,survey_id,department,location) VALUES($1,$2,$3,$4) RETURNING id`
          : `INSERT INTO survey_responses(organization_id,survey_id,department,location,employee_id,submitted_at) VALUES($1,$2,$3,$4,$5,now()) RETURNING id`,
        row.anonymous ? [identity.organizationId, row.id, me.department || null, me.location || null]
          : [identity.organizationId, row.id, me.department || null, me.location || null, identity.employeeId])).rows[0].id;
      await client.query(`UPDATE survey_invitations SET responded_on=current_date WHERE organization_id=$1 AND survey_id=$2 AND employee_id=$3`,
        [identity.organizationId, row.id, identity.employeeId]);
    }
    for (const answer of answers)
      await client.query(`INSERT INTO survey_answers(organization_id,response_id,question_id,numeric_value,choice_values,text_value) VALUES($1,$2,$3,$4,$5,$6)`,
        [identity.organizationId, responseId, answer.questionId, answer.value ?? null, answer.choices ?? null, answer.text ?? null]);
    // Identified responses are audited. Anonymous participation is deliberately not written to the audit log with
    // a precise timestamp — survey_invitations already records it at day granularity.
    if (!row.anonymous && identity.userId)
      await this.audit(client, identity, invitation.responded_on ? `${row.kind}_RESPONSE_EDITED` : `${row.kind}_RESPONSE_SUBMITTED`, row.id, null, { answered: answers.length });
  }

  // ---- polls -------------------------------------------------------------------------------------

  polls(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      await this.sweep(client, identity);
      const rows = (await client.query(
        `${SELECT_SURVEY} WHERE s.organization_id=$1 AND s.kind='POLL' AND s.status<>'DRAFT'
            AND (mi.employee_id IS NOT NULL OR ($3 OR s.owner_id=$2))
            AND (s.status='LIVE' OR s.closed_at > now() - interval '30 days')
          ORDER BY (s.status='LIVE') DESC, s.launched_at DESC LIMIT 12`,
        [identity.organizationId, identity.employeeId, this.isHr(identity)])).rows;
      const items = [];
      for (const row of rows) items.push(await this.presentPoll(client, identity, row));
      const reports = await this.directReports(client, identity);
      return { items, viewer: this.viewer(identity, reports) };
    });
  }

  createPoll(identity: AuthIdentity, input: CreatePollDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const reports = await this.directReports(client, identity);
      this.checkAudience(identity, reports, input.audienceType, input.audienceValues);
      const { closesAt } = this.checkDates(null, input.closesAt);
      const options = this.cleanOptions(input.options, "Poll");
      const audience = await this.resolveAudience(client, identity, input.audienceType, input.audienceValues, identity.employeeId);
      if (!audience.length) throw new BadRequestException("Nobody matches this audience yet.");
      const row = (await client.query(
        `INSERT INTO surveys(organization_id,kind,title,status,anonymous,allow_edit,share_results,audience_type,audience_values,owner_id,opens_at,closes_at,launched_at)
         VALUES($1,'POLL',$2,'DRAFT',$3,false,true,$4,$5,$6,now(),$7,now()) RETURNING id`,
        [identity.organizationId, input.question.trim(), input.anonymous, input.audienceType, this.cleanList(input.audienceValues), identity.employeeId, closesAt])).rows[0];
      // Polls go live immediately; the single question is written while still a draft (the trigger locks questions after).
      await this.writeQuestions(client, identity, row.id, [{
        type: input.multiple ? "MULTI_CHOICE" : "SINGLE_CHOICE", prompt: input.question.trim(), helpText: null, required: true, options, scaleLabels: [],
      }]);
      await client.query(`UPDATE surveys SET status='LIVE' WHERE organization_id=$1 AND id=$2`, [identity.organizationId, row.id]);
      await this.invite(client, identity, row.id, audience);
      await this.audit(client, identity, "POLL_CREATED", row.id, null, { question: input.question, options, invited: audience.length });
      const created = await this.load(client, identity, row.id);
      return this.presentPoll(client, identity, created);
    });
  }

  vote(identity: AuthIdentity, id: string, input: VoteDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      await this.sweep(client, identity);
      const row = await this.load(client, identity, id);
      if (row.kind !== "POLL") throw new BadRequestException("This is not a poll.");
      const [question] = await this.questions(client, identity, id);
      const answers = this.validateAnswers([question], [{ questionId: question.id, choices: input.choices }], true);
      await this.saveResponse(client, identity, row, answers);
      return this.presentPoll(client, identity, await this.load(client, identity, id));
    });
  }

  private async presentPoll(client: PoolClient, identity: AuthIdentity, row: Row) {
    const base = this.present(identity, row);
    const [question] = await this.questions(client, identity, row.id);
    const voted = !!row.me_responded_on;
    const showResults = voted || base.state === "CLOSED" || base.canManage || !row.me_invited;
    let results: { option: string; count: number; pct: number }[] | null = null;
    let votes = 0;
    if (question) {
      const counts = (await client.query(
        `SELECT choice, count(*)::int AS count FROM survey_answers a, unnest(a.choice_values) AS choice
          WHERE a.organization_id=$1 AND a.question_id=$2 GROUP BY choice`, [identity.organizationId, question.id])).rows;
      votes = (await client.query(`SELECT count(*)::int AS n FROM survey_responses WHERE organization_id=$1 AND survey_id=$2`, [identity.organizationId, row.id])).rows[0].n;
      if (showResults) results = question.options.map((option: string) => {
        const count = counts.find((item) => item.choice === option)?.count || 0;
        return { option, count, pct: votes ? Math.round((count / votes) * 100) : 0 };
      });
    }
    return {
      ...base, question: question ? { id: question.id, prompt: question.prompt, multiple: question.type === "MULTI_CHOICE", options: question.options } : null,
      voted, votes, results,
    };
  }

  // ---- results -----------------------------------------------------------------------------------

  results(identity: AuthIdentity, id: string, query: ResultsQuery) {
    return this.database.tenantTransaction(identity, async (client) => {
      await this.sweep(client, identity);
      const row = await this.load(client, identity, id);
      return this.computeResults(client, identity, row, query.breakdown || "department");
    });
  }

  private async computeResults(client: PoolClient, identity: AuthIdentity, row: Row, breakdownBy: "department" | "location") {
    const canManage = this.canManage(identity, row);
    const shared = !canManage && row.share_results && this.state(row) === "CLOSED" && row.me_invited;
    if (!canManage && !shared) throw new ForbiddenException("Results are available to the survey owner and HR.");
    const survey = this.present(identity, row);
    const k = Number(row.min_group_size) || 3;
    const questions = await this.questions(client, identity, row.id);
    const responses = (await client.query(
      `SELECT r.id, r.department, r.location, r.employee_id, e.full_name, to_char(r.submitted_on,'YYYY-MM-DD') AS day
         FROM survey_responses r LEFT JOIN employees e ON e.id=r.employee_id AND e.organization_id=r.organization_id
        WHERE r.organization_id=$1 AND r.survey_id=$2 ORDER BY md5(r.id::text)`, [identity.organizationId, row.id])).rows;
    const n = responses.length;
    const protectedMode = row.anonymous || shared;
    const invitedBySegment = (await client.query(
      `SELECT coalesce(nullif(e.${breakdownBy},''),'Unassigned') AS segment, count(*)::int AS invited FROM survey_invitations i
         JOIN employees e ON e.id=i.employee_id AND e.organization_id=i.organization_id
        WHERE i.organization_id=$1 AND i.survey_id=$2 GROUP BY 1`, [identity.organizationId, row.id])).rows;
    const header = {
      survey, threshold: k, anonymous: row.anonymous, responses: n, invited: survey.invited, responded: survey.responded,
      responseRate: survey.responseRate, breakdownBy,
    };
    if (row.anonymous && n < k)
      return { ...header, locked: true, needed: k - n, trend: [], questions: questions.map((question) => ({ ...question, locked: true })), headline: null, breakdown: null };

    const answers = (await client.query(
      `SELECT a.response_id, a.question_id, a.numeric_value, a.choice_values, a.text_value FROM survey_answers a
         JOIN survey_responses r ON r.id=a.response_id AND r.organization_id=a.organization_id
        WHERE a.organization_id=$1 AND r.survey_id=$2`, [identity.organizationId, row.id])).rows;
    const byQuestion = new Map<string, Row[]>();
    for (const answer of answers) byQuestion.set(answer.question_id, [...(byQuestion.get(answer.question_id) || []), answer]);
    const responseById = new Map(responses.map((response) => [response.id, response]));

    const questionResults = questions.map((question) => {
      const list = byQuestion.get(question.id) || [];
      return { ...question, ...summarise(question, list, (answer) => {
        const response = responseById.get(answer.response_id);
        return !protectedMode && response?.employee_id ? { name: response.full_name, department: response.department } : null;
      }, protectedMode ? k : 0) };
    });

    // Participation trend: responses per day (day granularity only, by design).
    const trendMap = new Map<string, number>();
    for (const response of responses) trendMap.set(response.day, (trendMap.get(response.day) || 0) + 1);
    const trend = [...trendMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count }));

    const numeric = questions.filter((question) => question.type === "RATING" || question.type === "ENPS");
    const enpsQuestion = questionResults.find((question) => question.type === "ENPS" && !question.locked);
    const ratings = questionResults.filter((question) => question.type === "RATING" && !question.locked && question.answered);
    const headline = {
      enps: enpsQuestion ? enpsQuestion.score : null,
      favorable: ratings.length ? Math.round(ratings.reduce((sum, question) => sum + (question.favorable || 0), 0) / ratings.length) : null,
      average: ratings.length ? round2(ratings.reduce((sum, question) => sum + (question.average || 0), 0) / ratings.length) : null,
    };

    // Segment breakdown with small-cell suppression: segments under the threshold are pooled into "Other groups";
    // if that pool is itself too small, the next smallest segment joins it so no group can be derived by subtraction.
    const groups = new Map<string, string[]>();
    for (const response of responses) {
      const key = (response[breakdownBy] as string) || "Unassigned";
      groups.set(key, [...(groups.get(key) || []), response.id]);
    }
    let visible = [...groups.entries()].map(([name, ids]) => ({ name, ids, members: [name] })).sort((a, b) => b.ids.length - a.ids.length);
    const pooled = { name: "Other groups", ids: [] as string[], members: [] as string[] };
    if (protectedMode) {
      for (const group of visible.filter((item) => item.ids.length < k)) { pooled.ids.push(...group.ids); pooled.members.push(group.name); }
      visible = visible.filter((item) => item.ids.length >= k);
      while (pooled.ids.length > 0 && pooled.ids.length < k && visible.length) {
        const smallest = visible.pop()!;
        pooled.ids.push(...smallest.ids); pooled.members.push(smallest.name);
      }
    }
    const segmentRows = [...visible, ...(pooled.ids.length ? [pooled] : [])].map((group) => {
      const ids = new Set(group.ids);
      const suppressed = protectedMode && group.ids.length < k;
      const invited = invitedBySegment.filter((item) => group.members.includes(item.segment)).reduce((sum, item) => sum + item.invited, 0);
      return {
        name: group.name, members: group.members, responses: group.ids.length, suppressed, invited,
        responseRate: invited ? Math.round((group.ids.length / invited) * 100) : null,
        scores: suppressed ? {} : Object.fromEntries(numeric.map((question) => {
          const list = (byQuestion.get(question.id) || []).filter((answer) => ids.has(answer.response_id));
          const summary = summarise(question, list, () => null, 0);
          return [question.id, question.type === "ENPS" ? { score: summary.score, answered: summary.answered } : { average: summary.average, favorable: summary.favorable, answered: summary.answered }];
        })),
      };
    });
    const breakdown = {
      by: breakdownBy, threshold: k, questions: numeric.map((question) => ({ id: question.id, type: question.type, prompt: question.prompt })),
      segments: segmentRows, hiddenCount: segmentRows.filter((item) => item.suppressed).length,
    };
    return { ...header, locked: false, needed: 0, trend, questions: questionResults, headline, breakdown };
  }

  async csv(identity: AuthIdentity, id: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const row = await this.load(client, identity, id);
      this.requireManage(identity, row);
      const questions = await this.questions(client, identity, id);
      const responses = (await client.query(
        `SELECT r.id, r.employee_id, e.full_name, e.employee_number, r.department, r.location, r.submitted_at, r.updated_at
           FROM survey_responses r LEFT JOIN employees e ON e.id=r.employee_id AND e.organization_id=r.organization_id
          WHERE r.organization_id=$1 AND r.survey_id=$2 ORDER BY ${row.anonymous ? "md5(r.id::text)" : "r.submitted_at"}`, [identity.organizationId, id])).rows;
      if (row.anonymous && responses.length < row.min_group_size)
        throw new ForbiddenException(`Exports unlock once ${row.min_group_size} people have responded.`);
      const answers = (await client.query(
        `SELECT a.response_id, a.question_id, a.numeric_value, a.choice_values, a.text_value FROM survey_answers a
           JOIN survey_responses r ON r.id=a.response_id AND r.organization_id=a.organization_id WHERE a.organization_id=$1 AND r.survey_id=$2`,
        [identity.organizationId, id])).rows;
      const lookup = new Map(answers.map((answer) => [`${answer.response_id}:${answer.question_id}`, answer]));
      // Anonymous exports carry no identity, segment or time columns and are shuffled, so rows can't be matched to people.
      const head = ["Response", ...(row.anonymous ? [] : ["Employee", "Employee no.", "Department", "Location", "Submitted at", "Last edited"]),
        ...questions.map((question, index) => `Q${index + 1}. ${question.prompt}`)];
      const lines = [head];
      responses.forEach((response, index) => lines.push([
        String(index + 1),
        ...(row.anonymous ? [] : [response.full_name, response.employee_number, response.department || "", response.location || "",
          response.submitted_at ? new Date(response.submitted_at).toISOString() : "", response.updated_at ? new Date(response.updated_at).toISOString() : ""]),
        ...questions.map((question) => {
          const answer = lookup.get(`${response.id}:${question.id}`);
          if (!answer) return "";
          const value = this.answerValue(answer);
          return Array.isArray(value) ? value.join("; ") : String(value ?? "");
        }),
      ]));
      await this.audit(client, identity, "SURVEY_EXPORTED", id, null, { rows: responses.length, anonymous: row.anonymous });
      const body = "﻿" + lines.map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
      const name = `${row.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "survey"}-responses.csv`;
      return { body: Buffer.from(body, "utf8"), name };
    });
  }

  // ---- helpers -----------------------------------------------------------------------------------

  private isHr(identity: AuthIdentity) { return identity.roles.some((role) => HR_ROLES.includes(role)); }

  private viewer(identity: AuthIdentity, reports: number) {
    const isHr = this.isHr(identity);
    return { employeeId: identity.employeeId, roles: identity.roles.filter(Boolean), isHr, teamSize: reports, canBuild: isHr || reports > 0 };
  }

  private async directReports(client: PoolClient, identity: AuthIdentity) {
    return (await client.query(`SELECT count(*)::int AS n FROM employees WHERE organization_id=$1 AND manager_id=$2 AND status='ACTIVE'`,
      [identity.organizationId, identity.employeeId])).rows[0].n as number;
  }

  private canManage(identity: AuthIdentity, row: Row) { return this.isHr(identity) || row.owner_id === identity.employeeId; }

  private requireManage(identity: AuthIdentity, row: Row) {
    if (!this.canManage(identity, row)) throw new ForbiddenException("Only the survey owner and HR can do this.");
  }

  /** Surveys past their close date are closed lazily on read, so no scheduler is needed. */
  private async sweep(client: PoolClient, identity: AuthIdentity) {
    await client.query(`UPDATE surveys SET status='CLOSED', closed_at=closes_at, version=version+1, updated_at=now()
      WHERE organization_id=$1 AND status='LIVE' AND closes_at IS NOT NULL AND closes_at <= now()`, [identity.organizationId]);
  }

  private async load(client: PoolClient, identity: AuthIdentity, id: string, lock = false) {
    if (!UUID.test(id)) throw new NotFoundException("Survey not found.");
    const row = (await client.query(`${SELECT_SURVEY} WHERE s.organization_id=$1 AND s.id=$3${lock ? " FOR UPDATE OF s" : ""}`,
      [identity.organizationId, identity.employeeId, id])).rows[0];
    if (!row) throw new NotFoundException("Survey not found.");
    const visible = this.canManage(identity, row) || (row.status !== "DRAFT" && row.me_invited);
    if (!visible) throw new NotFoundException("Survey not found.");
    return row;
  }

  private state(row: Row): "DRAFT" | "SCHEDULED" | "LIVE" | "CLOSED" {
    if (row.status === "DRAFT") return "DRAFT";
    if (row.status === "CLOSED" || (row.closes_at && new Date(row.closes_at).getTime() <= Date.now())) return "CLOSED";
    if (row.opens_at && new Date(row.opens_at).getTime() > Date.now()) return "SCHEDULED";
    return "LIVE";
  }

  private present(identity: AuthIdentity, row: Row) {
    const state = this.state(row);
    const invited = Number(row.invited) || 0;
    const responded = Number(row.responded) || 0;
    const questionCount = Number(row.question_count) || 0;
    const canManage = this.canManage(identity, row);
    const respondedOn = row.me_responded_on || null;
    const canRespond = !!row.me_invited && state === "LIVE" && (!respondedOn || (!row.anonymous && row.allow_edit));
    return {
      id: row.id, kind: row.kind, title: row.title, description: row.description, status: row.status, state,
      anonymous: row.anonymous, allowEdit: row.allow_edit, shareResults: row.share_results, minGroupSize: row.min_group_size,
      audience: { type: row.audience_type as AudienceType, values: row.audience_values || [], label: audienceLabel(row.audience_type, row.audience_values || []) },
      opensAt: row.opens_at, closesAt: row.closes_at, launchedAt: row.launched_at, closedAt: row.closed_at,
      createdAt: row.created_at, updatedAt: row.updated_at, version: row.version,
      owner: { id: row.owner_id, name: row.owner_name, designation: row.owner_designation },
      questionCount, estimatedMinutes: Math.max(1, Math.round(questionCount * 0.5)),
      invited, responded, responseRate: invited ? Math.round((responded / invited) * 100) : 0,
      canManage,
      canViewResults: canManage || (row.share_results && state === "CLOSED" && !!row.me_invited),
      me: { invited: !!row.me_invited, respondedOn, canRespond, canEdit: !!respondedOn && canRespond },
    };
  }

  private async questions(client: PoolClient, identity: AuthIdentity, surveyId: string) {
    const rows = (await client.query(
      `SELECT id, position, type, prompt, help_text, required, options, scale_labels FROM survey_questions
        WHERE organization_id=$1 AND survey_id=$2 ORDER BY position`, [identity.organizationId, surveyId])).rows;
    return rows.map((row) => ({
      id: row.id as string, position: row.position as number, type: row.type as QuestionType, prompt: row.prompt as string, helpText: row.help_text as string | null,
      required: row.required as boolean, options: (row.options || []) as string[],
      scaleLabels: ((row.scale_labels || []).length ? row.scale_labels : DEFAULT_SCALE[row.type] || []) as string[],
    }));
  }

  private normaliseQuestions(input: QuestionDto[]) {
    return input.map((question, index) => {
      const label = `Question ${index + 1}`;
      const options = CHOICE_TYPES.includes(question.type) ? this.cleanOptions(question.options || [], label) : [];
      let scaleLabels: string[] = [];
      if (question.type === "RATING" || question.type === "ENPS") {
        const expected = question.type === "RATING" ? 5 : 2;
        const labels = (question.scaleLabels || []).map((item) => item.trim());
        if (labels.length && labels.length !== expected) throw new BadRequestException(`${label}: provide ${expected} scale labels.`);
        if (labels.some((item) => !item)) throw new BadRequestException(`${label}: scale labels cannot be blank.`);
        scaleLabels = labels.length ? labels : DEFAULT_SCALE[question.type];
      }
      return { type: question.type, prompt: question.prompt.trim(), helpText: question.helpText?.trim() || null, required: question.required, options, scaleLabels };
    });
  }

  private cleanOptions(options: string[], label: string) {
    const cleaned = options.map((item) => item.trim()).filter(Boolean);
    if (cleaned.length < 2) throw new BadRequestException(`${label}: add at least two options.`);
    if (new Set(cleaned.map((item) => item.toLowerCase())).size !== cleaned.length) throw new BadRequestException(`${label}: options must be unique.`);
    return cleaned;
  }

  private cleanList(values: string[]) { return [...new Set((values || []).map((item) => item.trim()).filter(Boolean))]; }

  private async writeQuestions(client: PoolClient, identity: AuthIdentity, surveyId: string, questions: ReturnType<EngagementService["normaliseQuestions"]>) {
    for (const [index, question] of questions.entries())
      await client.query(
        `INSERT INTO survey_questions(organization_id,survey_id,position,type,prompt,help_text,required,options,scale_labels) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [identity.organizationId, surveyId, index, question.type, question.prompt, question.helpText, question.required, JSON.stringify(question.options), JSON.stringify(question.scaleLabels)]);
  }

  private checkAudience(identity: AuthIdentity, reports: number, type: AudienceType, values: string[], ownerId?: string) {
    const isHr = this.isHr(identity);
    if (!isHr && !reports) throw new ForbiddenException("Only HR and people managers can run surveys and polls.");
    if (!isHr && type !== "TEAM") throw new ForbiddenException("Managers can run surveys and polls for their own direct reports only.");
    if (type === "TEAM" && ownerId && ownerId !== identity.employeeId && !isHr) throw new ForbiddenException("Only the owner can change this audience.");
    if (type === "TEAM" && !reports && (!ownerId || ownerId === identity.employeeId)) throw new BadRequestException("You have no direct reports to survey.");
    if ((type === "DEPARTMENTS" || type === "LOCATIONS") && !this.cleanList(values).length)
      throw new BadRequestException(`Pick at least one ${type === "DEPARTMENTS" ? "department" : "location"}.`);
  }

  private checkSettings(anonymous: boolean, allowEdit: boolean) {
    if (anonymous && allowEdit) throw new BadRequestException("Anonymous responses can't be edited later, because we never keep a link between people and their answers. Turn off one of the two.");
  }

  private checkDates(opensAt?: string | Date | null, closesAt?: string | Date | null) {
    const open = opensAt ? new Date(opensAt) : null;
    const close = closesAt ? new Date(closesAt) : null;
    if (open && Number.isNaN(open.getTime())) throw new BadRequestException("The open date is not valid.");
    if (close && Number.isNaN(close.getTime())) throw new BadRequestException("The close date is not valid.");
    if (close && close.getTime() <= Date.now()) throw new BadRequestException("The close date must be in the future.");
    if (open && close && close <= open) throw new BadRequestException("The close date must be after the open date.");
    return { opensAt: open, closesAt: close };
  }

  private async resolveAudience(client: PoolClient, identity: AuthIdentity, type: AudienceType, values: string[], ownerId: string) {
    const where = ["organization_id=$1", "status='ACTIVE'"];
    const params: unknown[] = [identity.organizationId];
    if (type === "DEPARTMENTS") { params.push(values); where.push(`department = ANY($2)`); }
    if (type === "LOCATIONS") { params.push(values); where.push(`location = ANY($2)`); }
    if (type === "TEAM") { params.push(ownerId); where.push(`manager_id = $2`); }
    return (await client.query(`SELECT id FROM employees WHERE ${where.join(" AND ")}`, params)).rows.map((row) => row.id as string);
  }

  private async invite(client: PoolClient, identity: AuthIdentity, surveyId: string, employees: string[]) {
    await client.query(`INSERT INTO survey_invitations(organization_id,survey_id,employee_id) SELECT $1,$2,unnest($3::uuid[]) ON CONFLICT DO NOTHING`,
      [identity.organizationId, surveyId, employees]);
  }

  private validateAnswers(questions: Awaited<ReturnType<EngagementService["questions"]>>, input: AnswerDto[], poll = false): ValidAnswer[] {
    const errors: string[] = [];
    const byId = new Map(questions.map((question) => [question.id, question]));
    const seen = new Set<string>();
    for (const answer of input) {
      if (!byId.has(answer.questionId)) errors.push("An answer refers to a question that is not part of this survey.");
      if (seen.has(answer.questionId)) errors.push("Each question can be answered once.");
      seen.add(answer.questionId);
    }
    const output: ValidAnswer[] = [];
    questions.forEach((question, index) => {
      const label = poll ? "Your vote" : `Question ${index + 1}`;
      const answer = input.find((item) => item.questionId === question.id);
      const blank = !answer || (answer.value === undefined && !(answer.choices || []).length && !(answer.text || "").trim());
      if (blank) { if (question.required) errors.push(`${label} is required.`); return; }
      switch (question.type) {
        case "RATING": case "ENPS": {
          const max = question.type === "RATING" ? 5 : 10;
          const min = question.type === "RATING" ? 1 : 0;
          if (answer!.value === undefined || !Number.isInteger(answer!.value) || answer!.value < min || answer!.value > max) errors.push(`${label} needs a score from ${min} to ${max}.`);
          else output.push({ questionId: question.id, value: answer!.value });
          break;
        }
        case "SINGLE_CHOICE": case "MULTI_CHOICE": {
          const choices = [...new Set((answer!.choices || []).map((item) => item.trim()))];
          if (!choices.length) { if (question.required) errors.push(`${label} is required.`); break; }
          if (question.type === "SINGLE_CHOICE" && choices.length !== 1) errors.push(`${label} takes a single choice.`);
          else if (choices.some((choice) => !question.options.includes(choice))) errors.push(`${label} has an option that isn't offered.`);
          else output.push({ questionId: question.id, choices });
          break;
        }
        case "SHORT_TEXT": case "LONG_TEXT": {
          const text = (answer!.text || "").trim();
          if (text.length > TEXT_LIMIT[question.type]) errors.push(`${label} must be ${TEXT_LIMIT[question.type]} characters or fewer.`);
          else if (text) output.push({ questionId: question.id, text });
          else if (question.required) errors.push(`${label} is required.`);
          break;
        }
      }
    });
    if (errors.length) throw new BadRequestException([...new Set(errors)]);
    return output;
  }

  private answerValue(answer: Row) {
    if (answer.numeric_value !== null && answer.numeric_value !== undefined) return Number(answer.numeric_value);
    if (answer.choice_values) return answer.choice_values as string[];
    return answer.text_value as string | null;
  }

  private notifyMany(client: PoolClient, identity: AuthIdentity, employees: string[], eventType: string, surveyId: string, payload: Record<string, unknown>) {
    return client.query(
      `INSERT INTO workflow_events(organization_id,employee_id,event_type,entity_type,entity_id,payload) SELECT $1,unnest($2::uuid[]),$3,'survey',$4,$5`,
      [identity.organizationId, employees, eventType, surveyId, JSON.stringify(payload)]);
  }

  private async audit(client: PoolClient, identity: AuthIdentity, action: string, id: string, before: unknown, after: unknown) {
    if (!identity.userId) return; // audit_log.actor_user_id is required; login-less demo colleagues have no user.
    await client.query(`INSERT INTO audit_log(organization_id,actor_user_id,action,entity_type,entity_id,before_data,after_data) VALUES($1,$2,$3,'survey',$4,$5,$6)`,
      [identity.organizationId, identity.userId, action, id, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after)]);
  }
}

type ValidAnswer = { questionId: string; value?: number; choices?: string[]; text?: string };
type QuestionLite = { type: QuestionType; options: string[] };

/** Distribution + headline numbers for one question. `k` > 0 suppresses numeric/choice detail below k answers. */
function summarise(question: QuestionLite, list: Row[], author: (answer: Row) => { name: string; department: string } | null, k: number) {
  const answered = list.length;
  const base = { answered, locked: false as boolean, average: null as number | null, favorable: null as number | null, unfavorable: null as number | null,
    score: null as number | null, promoters: 0, passives: 0, detractors: 0, distribution: [] as { label: string; value: number; count: number; pct: number }[],
    options: [] as { option: string; count: number; pct: number }[], texts: [] as { text: string; author: { name: string; department: string } | null }[] };
  if (question.type === "SHORT_TEXT" || question.type === "LONG_TEXT") {
    base.texts = list.filter((answer) => answer.text_value).map((answer) => ({ text: answer.text_value as string, author: author(answer) }));
    return base;
  }
  if (k && answered < k) return { ...base, locked: true };
  const pct = (count: number) => (answered ? Math.round((count / answered) * 100) : 0);
  if (question.type === "RATING" || question.type === "ENPS") {
    const [min, max] = question.type === "RATING" ? [1, 5] : [0, 10];
    const values = list.map((answer) => Number(answer.numeric_value));
    for (let value = min; value <= max; value += 1) {
      const count = values.filter((item) => item === value).length;
      base.distribution.push({ label: String(value), value, count, pct: pct(count) });
    }
    base.average = answered ? round2(values.reduce((sum, value) => sum + value, 0) / answered) : null;
    if (question.type === "RATING") {
      base.favorable = answered ? pct(values.filter((value) => value >= 4).length) : null;
      base.unfavorable = answered ? pct(values.filter((value) => value <= 2).length) : null;
    } else {
      base.promoters = values.filter((value) => value >= 9).length;
      base.passives = values.filter((value) => value >= 7 && value <= 8).length;
      base.detractors = values.filter((value) => value <= 6).length;
      base.score = answered ? Math.round(((base.promoters - base.detractors) / answered) * 100) : null;
    }
    return base;
  }
  const counts = new Map<string, number>();
  for (const answer of list) for (const choice of answer.choice_values || []) counts.set(choice, (counts.get(choice) || 0) + 1);
  base.options = question.options.map((option) => ({ option, count: counts.get(option) || 0, pct: pct(counts.get(option) || 0) }));
  return base;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

function audienceLabel(type: string, values: string[]) {
  if (type === "ALL") return "Everyone";
  if (type === "TEAM") return "Direct reports";
  if (!values.length) return type === "DEPARTMENTS" ? "No departments" : "No locations";
  return values.length > 2 ? `${values.slice(0, 2).join(", ")} +${values.length - 2}` : values.join(", ");
}

function formatDay(value: string | Date) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(new Date(value));
}

function csvCell(value: string) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // neutralise spreadsheet formula injection
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
