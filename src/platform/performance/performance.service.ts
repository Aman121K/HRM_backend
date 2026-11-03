import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthIdentity } from "../auth/auth.types";
import { DatabaseService } from "../database/database.service";
import { PayrollService } from "../payroll/payroll.service";
import { audit, notify, num } from "../payroll/payroll.shared";
import { todayIst } from "../payroll/rules/types";
import type {
  AdvanceCycleDto, CalibrateDto, CycleDto, GoalDecisionDto, NominateDto, ProgressDto, ReviewDto, RevisionDecisionDto, SaveGoalsDto,
} from "./performance.dto";
import {
  CYCLE_FLOW, DEFAULT_COMPETENCIES, RATING_LABELS, band, computeScore, distribution, firstOfMonthOnOrAfter, goalProgress, suggestedIncrement, toRating,
  validateGoals, type Competency, type KeyResult,
} from "./perf-rules";

const HR_ROLES = ["HR_ADMIN", "OWNER"];
/** Peer/upward feedback is shown to the subject only once at least this many people have responded. */
const ANONYMITY_MIN = 2;

type Cycle = {
  id: string; name: string; period_start: string; period_end: string; status: string; goal_weight: number; self_review: boolean; peer_review: boolean;
  max_peers: number; competencies: Competency[]; department: string | null; goals_due: string | null; reviews_due: string | null; version: number;
};
type Participant = {
  id: string; employee_id: string; manager_id: string | null; goals_status: string; goals_note: string | null; self_status: string; manager_status: string;
  computed_score: string | null; final_rating: string | null; calibration_note: string | null; increment_pct: string | null; promote: boolean;
  new_designation: string | null; revision_status: string; revision_effective: string | null; revision_ctc: string | null; proposed_by: string | null;
  approved_by: string | null; published_at: string | null; version: number;
};

const CYCLE_COLUMNS = `id, name, to_char(period_start,'YYYY-MM-DD') AS period_start, to_char(period_end,'YYYY-MM-DD') AS period_end, status, goal_weight, self_review,
  peer_review, max_peers, competencies, department, to_char(goals_due,'YYYY-MM-DD') AS goals_due, to_char(reviews_due,'YYYY-MM-DD') AS reviews_due, version, created_at`;

@Injectable()
export class PerformanceService {
  constructor(private readonly database: DatabaseService, private readonly payroll: PayrollService) {}

  // ---------------------------------------------------------------- context & cycles

  context(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const isHr = this.isHr(identity);
      const cycles = (await client.query(
        `SELECT ${CYCLE_COLUMNS}, (SELECT count(*)::int FROM perf_participants p WHERE p.cycle_id=c.id) AS participants
           FROM perf_cycles c WHERE c.organization_id=$1 AND ($2::boolean OR (c.status<>'DRAFT' AND EXISTS (
             SELECT 1 FROM perf_participants p WHERE p.cycle_id=c.id AND (p.employee_id=$3 OR p.manager_id=$3))
             OR EXISTS (SELECT 1 FROM perf_reviews r WHERE r.cycle_id=c.id AND r.reviewer_id=$3)))
          ORDER BY c.created_at DESC LIMIT 50`, [org, isHr, identity.employeeId])).rows;
      const reports = (await client.query(`SELECT count(*)::int AS n FROM employees WHERE organization_id=$1 AND manager_id=$2 AND status='ACTIVE'`, [org, identity.employeeId])).rows[0].n;
      const pendingFeedback = (await client.query(
        `SELECT count(*)::int AS n FROM perf_reviews r JOIN perf_cycles c ON c.id=r.cycle_id
          WHERE r.organization_id=$1 AND r.reviewer_id=$2 AND r.relation IN ('PEER','REPORT') AND r.status='REQUESTED' AND c.status='REVIEW'`, [org, identity.employeeId])).rows[0].n;
      const departments = isHr ? (await client.query(
        `SELECT array_remove(array_agg(DISTINCT department ORDER BY department),NULL) AS d FROM employees WHERE organization_id=$1 AND status='ACTIVE'`, [org])).rows[0].d : [];
      return {
        viewer: { employeeId: identity.employeeId, isHr, reportCount: reports, pendingFeedback },
        cycles: cycles.map((row) => this.presentCycle(row)), defaultCompetencies: DEFAULT_COMPETENCIES, ratingLabels: RATING_LABELS, departments,
      };
    });
  }

  createCycle(identity: AuthIdentity, input: CycleDto) {
    this.requireHr(identity);
    if (input.periodEnd <= input.periodStart) throw new BadRequestException("The review period must end after it starts.");
    return this.database.tenantTransaction(identity, async (client) => {
      const competencies = input.competencies?.length ? input.competencies : DEFAULT_COMPETENCIES;
      const row = (await client.query(
        `INSERT INTO perf_cycles(organization_id,name,period_start,period_end,goal_weight,self_review,peer_review,max_peers,competencies,department,goals_due,reviews_due,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${CYCLE_COLUMNS}`,
        [identity.organizationId, input.name.trim(), input.periodStart, input.periodEnd, input.goalWeight ?? 70, input.selfReview ?? true, input.peerReview ?? true,
          input.maxPeers ?? 3, JSON.stringify(competencies), input.department || null, input.goalsDue || null, input.reviewsDue || null, identity.employeeId])).rows[0];
      await audit(client, identity, "PERF_CYCLE_CREATED", "perf_cycle", row.id, null, { name: row.name, periodStart: input.periodStart, periodEnd: input.periodEnd });
      return this.presentCycle(row);
    });
  }

  updateCycle(identity: AuthIdentity, id: string, input: CycleDto) {
    this.requireHr(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const cycle = await this.cycle(client, identity, id, true);
      if (cycle.status !== "DRAFT") {
        // After launch only due dates can move — weights and competencies are what people are being reviewed against.
        await client.query(`UPDATE perf_cycles SET goals_due=$3, reviews_due=$4, version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`,
          [identity.organizationId, id, input.goalsDue || null, input.reviewsDue || null]);
      } else {
        await client.query(
          `UPDATE perf_cycles SET name=$3, period_start=$4, period_end=$5, goal_weight=$6, self_review=$7, peer_review=$8, max_peers=$9, competencies=$10, department=$11,
                  goals_due=$12, reviews_due=$13, version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`,
          [identity.organizationId, id, input.name.trim(), input.periodStart, input.periodEnd, input.goalWeight ?? cycle.goal_weight, input.selfReview ?? cycle.self_review,
            input.peerReview ?? cycle.peer_review, input.maxPeers ?? cycle.max_peers, JSON.stringify(input.competencies?.length ? input.competencies : cycle.competencies),
            input.department || null, input.goalsDue || null, input.reviewsDue || null]);
      }
      await audit(client, identity, "PERF_CYCLE_UPDATED", "perf_cycle", id, { status: cycle.status }, input);
      return this.presentCycle(await this.cycle(client, identity, id));
    });
  }

  advance(identity: AuthIdentity, id: string, input: AdvanceCycleDto) {
    this.requireHr(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const cycle = await this.cycle(client, identity, id, true);
      if (cycle.version !== input.version) throw new ConflictException("This cycle changed since you opened it. Reload and try again.");
      const next = CYCLE_FLOW[cycle.status]?.next;
      if (!next) throw new ConflictException("This cycle is already closed.");
      const notes: string[] = [];
      if (cycle.status === "DRAFT") {
        const values: unknown[] = [org, cycle.period_end];
        let filter = "";
        if (cycle.department) { values.push(cycle.department); filter = ` AND department=$3`; }
        const people = (await client.query(
          `SELECT id, manager_id FROM employees WHERE organization_id=$1 AND status='ACTIVE' AND joining_date <= $2${filter}`, values)).rows;
        if (!people.length) throw new BadRequestException("No active employees match this cycle.");
        for (const person of people) {
          await client.query(`INSERT INTO perf_participants(organization_id,cycle_id,employee_id,manager_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [org, id, person.id, person.manager_id]);
          if (cycle.self_review) await this.ensureReview(client, org, id, person.id, person.id, "SELF", null);
          if (person.manager_id) await this.ensureReview(client, org, id, person.id, person.manager_id, "MANAGER", null);
          await notify(client, org, person.id, "PERF_GOALS_OPEN", "perf_cycle", id, { cycle: cycle.name, due: cycle.goals_due, link: "/performance" });
        }
        notes.push(`${people.length} people added.`);
      }
      if (cycle.status === "GOAL_SETTING") {
        const open = (await client.query(`SELECT count(*)::int AS n FROM perf_participants WHERE cycle_id=$1 AND goals_status<>'APPROVED'`, [id])).rows[0].n;
        if (open) notes.push(`${open} people don't have approved goals yet — they are reviewed on competencies only unless goals are approved.`);
        const people = (await client.query(`SELECT employee_id FROM perf_participants WHERE cycle_id=$1`, [id])).rows;
        for (const person of people) await notify(client, org, person.employee_id, "PERF_REVIEW_OPEN", "perf_cycle", id, { cycle: cycle.name, due: cycle.reviews_due, link: "/performance" });
      }
      if (cycle.status === "REVIEW") {
        const participants = (await client.query(`SELECT * FROM perf_participants WHERE cycle_id=$1 FOR UPDATE`, [id])).rows as Participant[];
        let missing = 0;
        for (const p of participants) {
          const score = await this.score(client, cycle, p.employee_id);
          if (score === null) missing += 1;
          const rating = p.final_rating !== null ? num(p.final_rating) : score === null ? null : toRating(score);
          const increment = p.increment_pct !== null ? num(p.increment_pct) : rating === null ? null : suggestedIncrement(rating);
          await client.query(`UPDATE perf_participants SET computed_score=$2, final_rating=$3, increment_pct=$4, version=version+1, updated_at=now() WHERE id=$1`,
            [p.id, score, rating, increment]);
        }
        if (missing) notes.push(`${missing} people have no manager review — rate them during calibration.`);
      }
      if (cycle.status === "CALIBRATION") {
        const unrated = (await client.query(`SELECT count(*)::int AS n FROM perf_participants WHERE cycle_id=$1 AND final_rating IS NULL`, [id])).rows[0].n;
        if (unrated) throw new ConflictException(`${unrated} people still need a final rating before results can be published.`);
        await client.query(`UPDATE perf_participants SET published_at=now() WHERE cycle_id=$1`, [id]);
        const people = (await client.query(`SELECT employee_id FROM perf_participants WHERE cycle_id=$1`, [id])).rows;
        for (const person of people) await notify(client, org, person.employee_id, "PERF_RESULT_PUBLISHED", "perf_cycle", id, { cycle: cycle.name, link: "/performance" });
      }
      await client.query(`UPDATE perf_cycles SET status=$3, version=version+1, updated_at=now() WHERE organization_id=$1 AND id=$2`, [org, id, next]);
      await audit(client, identity, "PERF_CYCLE_ADVANCED", "perf_cycle", id, { status: cycle.status }, { status: next, notes });
      return { cycle: this.presentCycle(await this.cycle(client, identity, id)), notes };
    });
  }

  // ---------------------------------------------------------------- one person's sheet

  /** The viewer's own sheet (goals, self review, nominations, published result). */
  mine(identity: AuthIdentity, cycleId: string) {
    return this.sheet(identity, cycleId, identity.employeeId);
  }

  /** A report's sheet for their manager, or anyone's for HR. */
  person(identity: AuthIdentity, cycleId: string, employeeId: string) {
    return this.sheet(identity, cycleId, employeeId);
  }

  private sheet(identity: AuthIdentity, cycleId: string, employeeId: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const cycle = await this.cycle(client, identity, cycleId);
      const p = await this.participant(client, cycleId, employeeId);
      const role = this.roleFor(identity, p);
      const employee = (await client.query(
        `SELECT e.id, e.full_name, e.employee_number, e.designation, e.department, m.full_name AS manager_name
           FROM employees e LEFT JOIN employees m ON m.id=$3 AND m.organization_id=e.organization_id WHERE e.organization_id=$1 AND e.id=$2`, [org, employeeId, p.manager_id])).rows[0];
      const goals = (await client.query(`SELECT * FROM perf_goals WHERE organization_id=$1 AND cycle_id=$2 AND employee_id=$3 ORDER BY sort_order, created_at`, [org, cycleId, employeeId])).rows;
      const reviews = (await client.query(
        `SELECT r.*, e.full_name AS reviewer_name FROM perf_reviews r JOIN employees e ON e.id=r.reviewer_id AND e.organization_id=r.organization_id
          WHERE r.organization_id=$1 AND r.cycle_id=$2 AND r.subject_id=$3 ORDER BY r.relation, r.created_at`, [org, cycleId, employeeId])).rows;
      const self = reviews.find((r) => r.relation === "SELF");
      const manager = reviews.find((r) => r.relation === "MANAGER");
      const others = reviews.filter((r) => r.relation === "PEER" || r.relation === "REPORT");
      const published = Boolean(p.published_at);
      const isSubject = role === "self";
      // The subject sees the manager review only once results are published; peers are aggregated (never named) for everyone but HR.
      const showManager = !isSubject || published;
      const submittedOthers = others.filter((r) => r.status === "SUBMITTED");
      const feedback = (role === "hr" || role === "manager" || (isSubject && published)) && submittedOthers.length >= (role === "hr" ? 1 : ANONYMITY_MIN)
        ? this.aggregate(cycle.competencies, submittedOthers, role === "hr") : null;
      return {
        cycle: this.presentCycle(cycle), viewerRole: role,
        employee: { id: employee.id, name: employee.full_name, number: employee.employee_number, designation: employee.designation, department: employee.department, manager: employee.manager_name },
        participant: {
          id: p.id, goalsStatus: p.goals_status, goalsNote: p.goals_note, selfStatus: p.self_status, managerStatus: p.manager_status, version: p.version,
          ...(isSubject && !published ? {} : {
            computedScore: p.computed_score === null ? null : num(p.computed_score), finalRating: p.final_rating === null ? null : num(p.final_rating),
            band: p.final_rating === null ? null : band(num(p.final_rating)), calibrationNote: role === "hr" ? p.calibration_note : null,
            incrementPct: role === "self" ? null : p.increment_pct === null ? null : num(p.increment_pct), promote: p.promote, newDesignation: p.new_designation,
            revisionStatus: role === "self" ? null : p.revision_status,
          }),
        },
        goals: goals.map((g) => ({
          id: g.id, title: g.title, description: g.description, weight: g.weight, keyResults: g.key_results, progress: g.progress,
          selfRating: g.self_rating, selfComment: g.self_comment,
          managerRating: showManager ? g.manager_rating : null, managerComment: showManager ? g.manager_comment : null,
        })),
        selfReview: self ? this.presentReview(self, true) : null,
        managerReview: manager && showManager ? this.presentReview(manager, true) : manager ? { status: manager.status } : null,
        nominations: others.map((r) => ({ id: r.id, relation: r.relation, status: r.status, reviewer: role === "hr" || role === "manager" || !published ? r.reviewer_name : null })),
        feedback,
        live: this.liveScore(cycle, goals, manager),
        anonymityMin: ANONYMITY_MIN,
      };
    });
  }

  saveGoals(identity: AuthIdentity, cycleId: string, input: SaveGoalsDto, employeeId = identity.employeeId) {
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const cycle = await this.cycle(client, identity, cycleId);
      if (!["GOAL_SETTING", "REVIEW"].includes(cycle.status)) throw new ConflictException("Goals can only be edited while the cycle is in goal setting.");
      const p = await this.participant(client, cycleId, employeeId, true);
      const role = this.roleFor(identity, p);
      if (role === "self" && p.goals_status === "APPROVED" && cycle.status !== "GOAL_SETTING") throw new ConflictException("Your goals are approved and the cycle has moved to reviews.");
      if (role === "self" && p.goals_status === "SUBMITTED") throw new ConflictException("Your goals are with your manager. Ask them to send them back to make changes.");
      if (input.submit) { const errors = validateGoals(input.goals); if (errors.length) throw new BadRequestException(errors.join(" ")); }
      const keep = input.goals.map((g) => g.id).filter(Boolean) as string[];
      await client.query(`DELETE FROM perf_goals WHERE organization_id=$1 AND cycle_id=$2 AND employee_id=$3 AND NOT (id = ANY($4::uuid[]))`, [org, cycleId, employeeId, keep]);
      for (const [index, goal] of input.goals.entries()) {
        const progress = goalProgress(goal.keyResults) ?? 0;
        if (goal.id) {
          const updated = await client.query(
            `UPDATE perf_goals SET title=$5, description=$6, weight=$7, key_results=$8, progress=$9, sort_order=$10, updated_at=now()
              WHERE organization_id=$1 AND cycle_id=$2 AND employee_id=$3 AND id=$4`,
            [org, cycleId, employeeId, goal.id, goal.title.trim(), goal.description?.trim() || null, goal.weight, JSON.stringify(goal.keyResults), progress, index]);
          if (updated.rowCount) continue;
        }
        await client.query(
          `INSERT INTO perf_goals(organization_id,cycle_id,employee_id,title,description,weight,key_results,progress,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [org, cycleId, employeeId, goal.title.trim(), goal.description?.trim() || null, goal.weight, JSON.stringify(goal.keyResults), progress, index]);
      }
      // A manager or HR setting goals for someone approves them in the same step.
      const status = role === "self" ? (input.submit ? "SUBMITTED" : "DRAFT") : (input.submit ? "APPROVED" : p.goals_status);
      await client.query(`UPDATE perf_participants SET goals_status=$2, version=version+1, updated_at=now() WHERE id=$1`, [p.id, status]);
      if (role === "self" && input.submit && p.manager_id)
        await notify(client, org, p.manager_id, "PERF_GOALS_SUBMITTED", "perf_cycle", cycleId, { cycle: cycle.name, employeeId, link: "/performance" });
      await audit(client, identity, "PERF_GOALS_SAVED", "perf_participant", p.id, { goalsStatus: p.goals_status }, { goals: input.goals.length, goalsStatus: status });
      return { goalsStatus: status };
    });
  }

  decideGoals(identity: AuthIdentity, cycleId: string, employeeId: string, input: GoalDecisionDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const cycle = await this.cycle(client, identity, cycleId);
      const p = await this.participant(client, cycleId, employeeId, true);
      const role = this.roleFor(identity, p);
      if (role === "self" || role === "peer") throw new ForbiddenException("Only the manager or HR can approve goals.");
      if (p.goals_status !== "SUBMITTED") throw new ConflictException("These goals haven't been submitted.");
      if (input.decision === "return" && !input.note?.trim()) throw new BadRequestException("Tell them what to change.");
      if (input.decision === "approve") {
        const goals = (await client.query(`SELECT weight FROM perf_goals WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, employeeId])).rows;
        const errors = validateGoals(goals);
        if (errors.length) throw new BadRequestException(errors.join(" "));
      }
      const status = input.decision === "approve" ? "APPROVED" : "DRAFT";
      await client.query(`UPDATE perf_participants SET goals_status=$2, goals_note=$3, version=version+1, updated_at=now() WHERE id=$1`, [p.id, status, input.note?.trim() || null]);
      await notify(client, identity.organizationId, employeeId, input.decision === "approve" ? "PERF_GOALS_APPROVED" : "PERF_GOALS_RETURNED", "perf_cycle", cycleId,
        { cycle: cycle.name, note: input.note || null, link: "/performance" });
      await audit(client, identity, input.decision === "approve" ? "PERF_GOALS_APPROVED" : "PERF_GOALS_RETURNED", "perf_participant", p.id, { goalsStatus: p.goals_status }, { goalsStatus: status, note: input.note || null });
      return { goalsStatus: status };
    });
  }

  /** Check-in on key results any time before calibration (only the goal owner or their manager). */
  updateProgress(identity: AuthIdentity, goalId: string, input: ProgressDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const goal = (await client.query(`SELECT g.*, c.status AS cycle_status FROM perf_goals g JOIN perf_cycles c ON c.id=g.cycle_id WHERE g.organization_id=$1 AND g.id=$2 FOR UPDATE OF g`,
        [identity.organizationId, goalId])).rows[0];
      if (!goal) throw new NotFoundException("Goal not found.");
      const p = await this.participant(client, goal.cycle_id, goal.employee_id);
      const role = this.roleFor(identity, p);
      if (role === "peer") throw new NotFoundException("Goal not found.");
      if (!["GOAL_SETTING", "REVIEW"].includes(goal.cycle_status)) throw new ConflictException("Progress is frozen once calibration starts.");
      if ((goal.key_results as KeyResult[]).length !== input.keyResults.length) throw new BadRequestException("Key results don't match the goal — edit the goal to add or remove them.");
      const merged = (goal.key_results as KeyResult[]).map((kr, i) => ({ ...kr, current: input.keyResults[i].current }));
      const progress = goalProgress(merged) ?? goal.progress;
      await client.query(`UPDATE perf_goals SET key_results=$3, progress=$4, updated_at=now() WHERE organization_id=$1 AND id=$2`, [identity.organizationId, goalId, JSON.stringify(merged), progress]);
      return { id: goalId, keyResults: merged, progress };
    });
  }

  // ---------------------------------------------------------------- reviews

  /** SELF (own sheet) or MANAGER (a report's sheet) review, saved as draft or submitted. */
  saveReview(identity: AuthIdentity, cycleId: string, employeeId: string, input: ReviewDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const cycle = await this.cycle(client, identity, cycleId);
      if (cycle.status !== "REVIEW" && !(cycle.status === "CALIBRATION" && this.isHr(identity))) throw new ConflictException("Reviews are open only during the review stage.");
      const p = await this.participant(client, cycleId, employeeId, true);
      const role = this.roleFor(identity, p);
      const relation = role === "self" ? "SELF" : role === "manager" || role === "hr" ? "MANAGER" : null;
      if (!relation) throw new ForbiddenException("You can't review this person.");
      if (relation === "SELF" && !cycle.self_review) throw new ConflictException("This cycle has no self review.");
      if (relation === "MANAGER" && identity.employeeId === employeeId) throw new ForbiddenException("You can't write your own manager review.");
      const reviewerId = relation === "SELF" ? employeeId : p.manager_id && role === "manager" ? p.manager_id : identity.employeeId;
      const existing = (await client.query(`SELECT * FROM perf_reviews WHERE cycle_id=$1 AND subject_id=$2 AND relation=$3 FOR UPDATE`, [cycleId, employeeId, relation])).rows[0];
      if (existing?.status === "SUBMITTED" && !(role === "hr" && cycle.status === "CALIBRATION")) throw new ConflictException("This review is already submitted.");
      const ratings = this.cleanRatings(cycle.competencies, input.competencyRatings);
      if (input.submit) {
        const goals = (await client.query(`SELECT id FROM perf_goals WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, employeeId])).rows;
        const rated = new Set((input.goals || []).map((g) => g.goalId));
        if (goals.some((g) => !rated.has(g.id))) throw new BadRequestException("Rate every goal before submitting.");
        if (cycle.competencies.some((c) => !ratings[c.key])) throw new BadRequestException("Rate every competency before submitting.");
      }
      for (const g of input.goals || []) {
        const column = relation === "SELF" ? "self" : "manager";
        await client.query(`UPDATE perf_goals SET ${column}_rating=$4, ${column}_comment=$5, updated_at=now() WHERE organization_id=$1 AND cycle_id=$2 AND id=$3 AND employee_id=$6`,
          [org, cycleId, g.goalId, g.rating, g.comment?.trim() || null, employeeId]);
      }
      const values = [JSON.stringify(ratings), input.overallRating ?? null, input.strengths?.trim() || null, input.improvements?.trim() || null, input.comments?.trim() || null,
        input.submit ? "SUBMITTED" : "REQUESTED"];
      if (existing) await client.query(
        `UPDATE perf_reviews SET competency_ratings=$2, overall_rating=$3, strengths=$4, improvements=$5, comments=$6, status=$7,
                submitted_at=CASE WHEN $7='SUBMITTED' THEN now() ELSE submitted_at END, reviewer_id=$8, updated_at=now() WHERE id=$1`, [existing.id, ...values, reviewerId]);
      else await client.query(
        `INSERT INTO perf_reviews(organization_id,cycle_id,subject_id,reviewer_id,relation,competency_ratings,overall_rating,strengths,improvements,comments,status,submitted_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $11='SUBMITTED' THEN now() END)`, [org, cycleId, employeeId, reviewerId, relation, ...values]);
      if (relation === "MANAGER" && (input.incrementPct !== undefined || input.promote !== undefined))
        await client.query(`UPDATE perf_participants SET increment_pct=coalesce($2,increment_pct), promote=coalesce($3,promote), new_designation=coalesce($4,new_designation), updated_at=now() WHERE id=$1`,
          [p.id, input.incrementPct ?? null, input.promote ?? null, input.newDesignation?.trim() || null]);
      if (input.submit) {
        await client.query(`UPDATE perf_participants SET ${relation === "SELF" ? "self_status" : "manager_status"}='SUBMITTED', version=version+1, updated_at=now() WHERE id=$1`, [p.id]);
        if (relation === "SELF" && p.manager_id) await notify(client, org, p.manager_id, "PERF_SELF_REVIEW_SUBMITTED", "perf_cycle", cycleId, { cycle: cycle.name, employeeId, link: "/performance" });
        await audit(client, identity, relation === "SELF" ? "PERF_SELF_REVIEW_SUBMITTED" : "PERF_MANAGER_REVIEW_SUBMITTED", "perf_participant", p.id, null, { overall: input.overallRating ?? null });
      }
      return { saved: true, submitted: Boolean(input.submit) };
    });
  }

  /** 360: the subject (or their manager / HR) picks peers or direct reports to give feedback. */
  nominate(identity: AuthIdentity, cycleId: string, input: NominateDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const org = identity.organizationId;
      const cycle = await this.cycle(client, identity, cycleId);
      if (!cycle.peer_review) throw new ConflictException("This cycle has no 360 feedback.");
      if (!["GOAL_SETTING", "REVIEW"].includes(cycle.status)) throw new ConflictException("Nominations are closed.");
      const subjectId = input.subjectId || identity.employeeId;
      const p = await this.participant(client, cycleId, subjectId);
      const role = this.roleFor(identity, p);
      if (role === "peer") throw new ForbiddenException("You can't nominate reviewers for this person.");
      const reviewers = [...new Set(input.reviewerIds)].filter((id) => id !== subjectId && id !== p.manager_id);
      const current = (await client.query(`SELECT count(*)::int AS n FROM perf_reviews WHERE cycle_id=$1 AND subject_id=$2 AND relation IN ('PEER','REPORT') AND status<>'DECLINED'`, [cycleId, subjectId])).rows[0].n;
      if (current + reviewers.length > cycle.max_peers && role !== "hr") throw new BadRequestException(`At most ${cycle.max_peers} people can give 360 feedback.`);
      const valid = (await client.query(`SELECT id, manager_id FROM employees WHERE organization_id=$1 AND status='ACTIVE' AND id = ANY($2)`, [org, reviewers])).rows;
      if (valid.length !== reviewers.length) throw new BadRequestException("Pick active colleagues only.");
      for (const reviewer of valid) {
        const relation = reviewer.manager_id === subjectId ? "REPORT" : "PEER";
        await this.ensureReview(client, org, cycleId, subjectId, reviewer.id, relation, identity.employeeId);
        await notify(client, org, reviewer.id, "PERF_FEEDBACK_REQUESTED", "perf_cycle", cycleId, { cycle: cycle.name, link: "/performance" });
      }
      await audit(client, identity, "PERF_REVIEWERS_NOMINATED", "perf_participant", p.id, null, { reviewers: valid.length });
      return { nominated: valid.length };
    });
  }

  /** Feedback the viewer has been asked to give (peer / upward), across open cycles. */
  feedbackRequests(identity: AuthIdentity) {
    return this.database.tenantTransaction(identity, async (client) => {
      const rows = (await client.query(
        `SELECT r.id, r.relation, r.status, r.competency_ratings, r.overall_rating, r.strengths, r.improvements, r.comments, r.cycle_id, c.name AS cycle_name, c.status AS cycle_status,
                c.competencies, to_char(c.reviews_due,'YYYY-MM-DD') AS reviews_due, e.full_name AS subject_name, e.designation AS subject_designation
           FROM perf_reviews r JOIN perf_cycles c ON c.id=r.cycle_id JOIN employees e ON e.id=r.subject_id AND e.organization_id=r.organization_id
          WHERE r.organization_id=$1 AND r.reviewer_id=$2 AND r.relation IN ('PEER','REPORT') AND c.status IN ('GOAL_SETTING','REVIEW','CALIBRATION')
          ORDER BY (r.status='REQUESTED') DESC, c.reviews_due NULLS LAST`, [identity.organizationId, identity.employeeId])).rows;
      return rows.map((row) => ({
        id: row.id, relation: row.relation, status: row.status, cycle: { id: row.cycle_id, name: row.cycle_name, status: row.cycle_status, reviewsDue: row.reviews_due },
        subject: { name: row.subject_name, designation: row.subject_designation }, competencies: row.competencies,
        draft: { competencyRatings: row.competency_ratings, overallRating: row.overall_rating, strengths: row.strengths, improvements: row.improvements, comments: row.comments },
      }));
    });
  }

  submitFeedback(identity: AuthIdentity, reviewId: string, input: ReviewDto) {
    return this.database.tenantTransaction(identity, async (client) => {
      const row = (await client.query(
        `SELECT r.*, c.status AS cycle_status, c.competencies FROM perf_reviews r JOIN perf_cycles c ON c.id=r.cycle_id
          WHERE r.organization_id=$1 AND r.id=$2 AND r.reviewer_id=$3 AND r.relation IN ('PEER','REPORT') FOR UPDATE OF r`, [identity.organizationId, reviewId, identity.employeeId])).rows[0];
      if (!row) throw new NotFoundException("Feedback request not found.");
      if (row.cycle_status !== "REVIEW") throw new ConflictException("Feedback can be given only during the review stage.");
      if (row.status !== "REQUESTED") throw new ConflictException("You've already responded to this request.");
      const ratings = this.cleanRatings(row.competencies, input.competencyRatings);
      if (input.submit && (row.competencies as Competency[]).some((c) => !ratings[c.key])) throw new BadRequestException("Rate every competency before submitting.");
      await client.query(
        `UPDATE perf_reviews SET competency_ratings=$2, overall_rating=$3, strengths=$4, improvements=$5, comments=$6, status=$7,
                submitted_at=CASE WHEN $7='SUBMITTED' THEN now() END, updated_at=now() WHERE id=$1`,
        [reviewId, JSON.stringify(ratings), input.overallRating ?? null, input.strengths?.trim() || null, input.improvements?.trim() || null, input.comments?.trim() || null,
          input.submit ? "SUBMITTED" : "REQUESTED"]);
      return { submitted: Boolean(input.submit) };
    });
  }

  declineFeedback(identity: AuthIdentity, reviewId: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const updated = await client.query(`UPDATE perf_reviews SET status='DECLINED', updated_at=now() WHERE organization_id=$1 AND id=$2 AND reviewer_id=$3 AND relation IN ('PEER','REPORT') AND status='REQUESTED'`,
        [identity.organizationId, reviewId, identity.employeeId]);
      if (!updated.rowCount) throw new NotFoundException("Feedback request not found.");
      return { declined: true };
    });
  }

  // ---------------------------------------------------------------- team, calibration & revisions

  team(identity: AuthIdentity, cycleId: string) {
    return this.database.tenantTransaction(identity, async (client) => {
      const cycle = await this.cycle(client, identity, cycleId);
      const all = this.isHr(identity);
      const rows = (await client.query(
        `SELECT p.*, e.full_name, e.employee_number, e.designation, e.department, m.full_name AS manager_name,
                (SELECT count(*)::int FROM perf_goals g WHERE g.cycle_id=p.cycle_id AND g.employee_id=p.employee_id) AS goals,
                (SELECT coalesce(round(sum(g.progress*g.weight)::numeric/nullif(sum(g.weight),0)),0)::int FROM perf_goals g WHERE g.cycle_id=p.cycle_id AND g.employee_id=p.employee_id) AS progress,
                (SELECT count(*)::int FROM perf_reviews r WHERE r.cycle_id=p.cycle_id AND r.subject_id=p.employee_id AND r.relation IN ('PEER','REPORT') AND r.status='SUBMITTED') AS feedback_in,
                (SELECT count(*)::int FROM perf_reviews r WHERE r.cycle_id=p.cycle_id AND r.subject_id=p.employee_id AND r.relation IN ('PEER','REPORT') AND r.status<>'DECLINED') AS feedback_asked
           FROM perf_participants p JOIN employees e ON e.id=p.employee_id AND e.organization_id=p.organization_id
           LEFT JOIN employees m ON m.id=p.manager_id AND m.organization_id=p.organization_id
          WHERE p.organization_id=$1 AND p.cycle_id=$2 AND ($3::boolean OR p.manager_id=$4) ORDER BY e.department NULLS LAST, e.full_name`,
        [identity.organizationId, cycleId, all, identity.employeeId])).rows;
      const ratings = rows.filter((r) => r.final_rating !== null).map((r) => num(r.final_rating));
      return {
        cycle: this.presentCycle(cycle), scope: all ? "all" : "team",
        people: rows.map((r) => ({
          participantId: r.id, employeeId: r.employee_id, name: r.full_name, number: r.employee_number, designation: r.designation, department: r.department, manager: r.manager_name,
          goals: r.goals, progress: r.progress, goalsStatus: r.goals_status, selfStatus: r.self_status, managerStatus: r.manager_status,
          feedback: { received: r.feedback_in, requested: r.feedback_asked },
          computedScore: r.computed_score === null ? null : num(r.computed_score), finalRating: r.final_rating === null ? null : num(r.final_rating),
          incrementPct: r.increment_pct === null ? null : num(r.increment_pct), promote: r.promote, newDesignation: r.new_designation,
          revisionStatus: r.revision_status, revisionCtc: r.revision_ctc === null ? null : num(r.revision_ctc), version: r.version,
          calibrationNote: all ? r.calibration_note : null, proposedByMe: r.proposed_by === identity.employeeId,
        })),
        distribution: distribution(ratings),
        summary: {
          total: rows.length, goalsApproved: rows.filter((r) => r.goals_status === "APPROVED").length,
          selfDone: rows.filter((r) => r.self_status === "SUBMITTED").length, managerDone: rows.filter((r) => r.manager_status === "SUBMITTED").length,
          rated: ratings.length, averageRating: ratings.length ? Math.round(ratings.reduce((t, r) => t + r, 0) / ratings.length * 100) / 100 : null,
        },
      };
    });
  }

  calibrate(identity: AuthIdentity, cycleId: string, employeeId: string, input: CalibrateDto) {
    this.requireHr(identity);
    return this.database.tenantTransaction(identity, async (client) => {
      const cycle = await this.cycle(client, identity, cycleId);
      if (cycle.status !== "CALIBRATION") throw new ConflictException("Ratings can be calibrated only during calibration.");
      const p = await this.participant(client, cycleId, employeeId, true);
      if (p.version !== input.version) throw new ConflictException("Someone else changed this rating. Reload and try again.");
      if (employeeId === identity.employeeId) throw new ForbiddenException("Another administrator must calibrate your own rating.");
      const rating = Math.round(input.finalRating * 2) / 2;
      const moved = p.computed_score !== null && Math.abs(rating - toRating(num(p.computed_score))) >= 1;
      if (moved && !input.note?.trim()) throw new BadRequestException("Explain why the final rating differs from the review score by a full point or more.");
      const increment = input.incrementPct ?? (p.increment_pct === null ? suggestedIncrement(rating) : num(p.increment_pct));
      const promote = input.promote ?? p.promote;
      const proposed = increment > 0 || promote;
      if (promote && !(input.newDesignation?.trim() || p.new_designation)) throw new BadRequestException("Enter the new designation for the promotion.");
      // Any change to the money resets an earlier approval (maker-checker).
      const changed = increment !== num(p.increment_pct) || promote !== p.promote || (input.newDesignation?.trim() || p.new_designation) !== p.new_designation;
      const revisionStatus = p.revision_status === "APPLIED" ? "APPLIED" : !proposed ? "NONE" : changed || p.revision_status === "NONE" ? "PROPOSED" : p.revision_status;
      if (p.revision_status === "APPLIED" && changed) throw new ConflictException("The salary revision is already applied — change it from payroll instead.");
      await client.query(
        `UPDATE perf_participants SET final_rating=$2, calibration_note=$3, increment_pct=$4, promote=$5, new_designation=$6, revision_status=$7,
                proposed_by=CASE WHEN $7='PROPOSED' THEN $8::uuid ELSE proposed_by END, approved_by=CASE WHEN $7='PROPOSED' THEN NULL ELSE approved_by END,
                version=version+1, updated_at=now() WHERE id=$1`,
        [p.id, rating, input.note?.trim() || null, increment, promote, input.newDesignation?.trim() || p.new_designation, revisionStatus, identity.employeeId]);
      await audit(client, identity, "PERF_CALIBRATED", "perf_participant", p.id,
        { finalRating: p.final_rating === null ? null : num(p.final_rating), incrementPct: p.increment_pct === null ? null : num(p.increment_pct), promote: p.promote },
        { finalRating: rating, incrementPct: increment, promote, note: input.note || null });
      return { finalRating: rating, band: band(rating), incrementPct: increment, promote, revisionStatus };
    });
  }

  /** approve (a different admin than the proposer) → apply (creates the salary structure, updates designation). */
  async revisions(identity: AuthIdentity, cycleId: string, input: RevisionDecisionDto) {
    this.requireHr(identity);
    if (input.action === "approve") return this.database.tenantTransaction(identity, async (client) => {
      const cycle = await this.cycle(client, identity, cycleId);
      if (!["CALIBRATION", "PUBLISHED", "CLOSED"].includes(cycle.status)) throw new ConflictException("Revisions are approved after reviews close.");
      const rows = (await client.query(
        `SELECT p.*, e.full_name FROM perf_participants p JOIN employees e ON e.id=p.employee_id AND e.organization_id=p.organization_id
          WHERE p.cycle_id=$1 AND p.id = ANY($2) FOR UPDATE OF p`, [cycleId, input.participantIds])).rows as (Participant & { full_name: string })[];
      const skipped: string[] = [];
      let approved = 0;
      for (const p of rows) {
        if (p.revision_status !== "PROPOSED") { skipped.push(`${p.full_name}: not awaiting approval`); continue; }
        if (p.proposed_by === identity.employeeId || p.employee_id === identity.employeeId) { skipped.push(`${p.full_name}: you proposed it (or it's yours) — another admin must approve`); continue; }
        await client.query(`UPDATE perf_participants SET revision_status='APPROVED', approved_by=$2, version=version+1, updated_at=now() WHERE id=$1`, [p.id, identity.employeeId]);
        await audit(client, identity, "PERF_REVISION_APPROVED", "perf_participant", p.id, { revisionStatus: "PROPOSED" }, { incrementPct: num(p.increment_pct), promote: p.promote });
        approved += 1;
      }
      return { approved, skipped };
    });

    // apply
    const effectiveFrom = firstOfMonthOnOrAfter(input.effectiveFrom || todayIst());
    const plan = await this.database.tenantTransaction(identity, async (client) => {
      const cycle = await this.cycle(client, identity, cycleId);
      if (!["PUBLISHED", "CLOSED"].includes(cycle.status)) throw new ConflictException("Publish the results before applying salary revisions.");
      return (await client.query(
        `SELECT p.id, p.employee_id, p.increment_pct, p.promote, p.new_designation, e.full_name,
                s.annual_ctc::float AS ctc, s.is_metro, s.template
           FROM perf_participants p JOIN employees e ON e.id=p.employee_id AND e.organization_id=p.organization_id
           LEFT JOIN LATERAL (SELECT * FROM salary_structures x WHERE x.organization_id=p.organization_id AND x.employee_id=p.employee_id ORDER BY x.effective_from DESC LIMIT 1) s ON true
          WHERE p.organization_id=$1 AND p.cycle_id=$2 AND p.id = ANY($3) AND p.revision_status='APPROVED'`, [identity.organizationId, cycleId, input.participantIds])).rows;
    });
    const applied: { name: string; from: number; to: number }[] = [], failed: { name: string; reason: string }[] = [];
    for (const row of plan) {
      try {
        let structureId: string | null = null, newCtc: number | null = null;
        if (num(row.increment_pct) > 0) {
          if (!row.ctc) throw new BadRequestException("No salary structure on file.");
          newCtc = Math.round(row.ctc * (1 + num(row.increment_pct) / 100) / 100) * 100;
          const structure = await this.payroll.createStructure(identity, {
            employeeId: row.employee_id, annualCtc: newCtc, isMetro: row.is_metro, template: row.template || undefined, effectiveFrom,
            reason: row.promote ? "PROMOTION" : "REVISION", notes: `Performance cycle revision: +${num(row.increment_pct)}%${row.promote ? ` · promoted to ${row.new_designation}` : ""}`,
          });
          structureId = structure.id;
          applied.push({ name: row.full_name, from: row.ctc, to: newCtc });
        }
        await this.database.tenantTransaction(identity, async (client) => {
          if (row.promote && row.new_designation)
            await client.query(`UPDATE employees SET designation=$3, updated_at=now() WHERE organization_id=$1 AND id=$2`, [identity.organizationId, row.employee_id, row.new_designation]);
          await client.query(`UPDATE perf_participants SET revision_status='APPLIED', revision_effective=$2, revision_ctc=$3, revision_structure_id=$4, version=version+1, updated_at=now() WHERE id=$1`,
            [row.id, effectiveFrom, newCtc, structureId]);
          await audit(client, identity, "PERF_REVISION_APPLIED", "perf_participant", row.id, null, { effectiveFrom, annualCtc: newCtc, promote: row.promote, designation: row.new_designation });
          await notify(client, identity.organizationId, row.employee_id, "PERF_REVISION_APPLIED", "perf_cycle", cycleId,
            { effectiveFrom, incrementPct: num(row.increment_pct), promote: row.promote, designation: row.new_designation, link: "/payroll" });
        });
      } catch (error: any) {
        failed.push({ name: row.full_name, reason: error?.response?.message || error?.message || "Failed" });
      }
    }
    return { effectiveFrom, applied, failed };
  }

  // ---------------------------------------------------------------- helpers

  private isHr(identity: AuthIdentity) { return identity.roles.some((role) => HR_ROLES.includes(role)); }
  private requireHr(identity: AuthIdentity) { if (!this.isHr(identity)) throw new ForbiddenException("Only HR can manage performance cycles."); }

  private roleFor(identity: AuthIdentity, p: Participant): "self" | "manager" | "hr" | "peer" {
    if (p.employee_id === identity.employeeId) return "self";
    if (p.manager_id === identity.employeeId) return "manager";
    if (this.isHr(identity)) return "hr";
    return "peer";
  }

  private async cycle(client: PoolClient, identity: AuthIdentity, id: string, forUpdate = false): Promise<Cycle> {
    const row = (await client.query(`SELECT ${CYCLE_COLUMNS} FROM perf_cycles WHERE organization_id=$1 AND id=$2${forUpdate ? " FOR UPDATE" : ""}`, [identity.organizationId, id])).rows[0];
    if (!row || (row.status === "DRAFT" && !this.isHr(identity))) throw new NotFoundException("Performance cycle not found.");
    return row;
  }

  private async participant(client: PoolClient, cycleId: string, employeeId: string, forUpdate = false): Promise<Participant> {
    const row = (await client.query(`SELECT * FROM perf_participants WHERE cycle_id=$1 AND employee_id=$2${forUpdate ? " FOR UPDATE" : ""}`, [cycleId, employeeId])).rows[0];
    if (!row) throw new NotFoundException("This person isn't part of the cycle.");
    return row;
  }

  private ensureReview(client: PoolClient, org: string, cycleId: string, subjectId: string, reviewerId: string, relation: string, nominatedBy: string | null) {
    return client.query(
      `INSERT INTO perf_reviews(organization_id,cycle_id,subject_id,reviewer_id,relation,nominated_by) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (cycle_id,subject_id,reviewer_id) DO UPDATE SET status=CASE WHEN perf_reviews.status='DECLINED' THEN 'REQUESTED' ELSE perf_reviews.status END`,
      [org, cycleId, subjectId, reviewerId, relation, nominatedBy]);
  }

  private async score(client: PoolClient, cycle: Cycle, employeeId: string) {
    const goals = (await client.query(`SELECT weight, manager_rating FROM perf_goals WHERE cycle_id=$1 AND employee_id=$2`, [cycle.id, employeeId])).rows;
    const manager = (await client.query(`SELECT competency_ratings FROM perf_reviews WHERE cycle_id=$1 AND subject_id=$2 AND relation='MANAGER' AND status='SUBMITTED'`, [cycle.id, employeeId])).rows[0];
    if (!manager) return null;
    return computeScore(cycle.goal_weight, goals.map((g) => ({ weight: g.weight, rating: g.manager_rating })), Object.values(manager.competency_ratings || {}).map(Number));
  }

  private liveScore(cycle: Cycle, goals: any[], manager: any) {
    if (!manager) return null;
    const score = computeScore(cycle.goal_weight, goals.map((g) => ({ weight: g.weight, rating: g.manager_rating })), Object.values(manager.competency_ratings || {}).map(Number));
    return score === null ? null : { score, rating: toRating(score), band: band(toRating(score)) };
  }

  private cleanRatings(competencies: Competency[], raw?: Record<string, number>) {
    const out: Record<string, number> = {};
    for (const c of competencies) { const v = Number(raw?.[c.key]); if (Number.isInteger(v) && v >= 1 && v <= 5) out[c.key] = v; }
    return out;
  }

  private aggregate(competencies: Competency[], reviews: any[], named: boolean) {
    const byCompetency = competencies.map((c) => {
      const values = reviews.map((r) => Number(r.competency_ratings?.[c.key])).filter((v) => v >= 1);
      return { key: c.key, label: c.label, average: values.length ? Math.round(values.reduce((t, v) => t + v, 0) / values.length * 10) / 10 : null, responses: values.length };
    });
    const texts = (field: string) => reviews.map((r) => ({ text: r[field] as string | null, by: named ? r.reviewer_name : null, relation: r.relation })).filter((t) => t.text);
    // Unnamed comments are shuffled so their order can't be matched to the nomination list.
    const order = <T>(items: T[]) => (named ? items : [...items].sort(() => Math.random() - 0.5));
    return { responses: reviews.length, competencies: byCompetency, strengths: order(texts("strengths")), improvements: order(texts("improvements")), comments: order(texts("comments")) };
  }

  private presentReview(row: any, includeText: boolean) {
    return {
      status: row.status, competencyRatings: row.competency_ratings, overallRating: row.overall_rating, submittedAt: row.submitted_at,
      ...(includeText ? { strengths: row.strengths, improvements: row.improvements, comments: row.comments } : {}),
    };
  }

  private presentCycle(row: any) {
    return {
      id: row.id, name: row.name, periodStart: row.period_start, periodEnd: row.period_end, status: row.status, statusLabel: CYCLE_FLOW[row.status]?.label || row.status,
      nextStatus: CYCLE_FLOW[row.status]?.next || null, goalWeight: row.goal_weight, selfReview: row.self_review, peerReview: row.peer_review, maxPeers: row.max_peers,
      competencies: row.competencies as Competency[], department: row.department, goalsDue: row.goals_due, reviewsDue: row.reviews_due, version: row.version,
      participants: row.participants ?? undefined,
    };
  }
}
