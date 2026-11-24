
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError, type EntityManager } from 'typeorm';
import { AcademicYear } from '../academic-years/academic-year.entity';
import {
  getAssessmentCategories,
  getAssessmentFields,
  getAssessmentMaxTotal,
  type AssessmentField,
} from '../assessments/assessment-categories';
import { AssessmentRecord } from '../assessments/assessment-record.entity';
import { AppError, Errors } from '../common/errors';
import type { AuthContext } from '../common/types';
import { PostgresStateService } from '../database/postgres-state.service';
import { ExamMark } from '../examinations/exam-mark.entity';
import { Examination } from '../examinations/examination.entity';
import { EventsService } from '../events/events.service';
import { assessmentState, assessmentTotal, emptyScores, type AssessmentScores } from '../results/calculations';
import { Section } from '../sections/section.entity';
import { AuditService, type AuditEntry } from '../security/audit.service';
import { TeacherScopeService } from '../teachers/teachers.service';
import type { AssessmentSaveDto, ExamMarksSaveDto, FinalizeAssessmentsDto } from './marks.schemas';

interface EnrollmentInfo {
  id: string;
  student_id: string;
  full_name: string;
  section_id: string;
  academic_year_id: string;
}

export interface SaveResult {
  created: number;
  updated: number;
  corrected: number;
  cleared: number;
  unchanged: number;
  records: Array<{ enrollmentId: string; id: string | null; version: number; status: 'entered' | 'finalized' | 'missing' }>;
}

export interface FinalizeResult {
  finalized: number;
  alreadyFinalized: number;
  /** records that are incomplete and therefore could not be finalized */
  incomplete: number;
  /** students with no record at all */
  missing: number;
}

const LOCKED_MESSAGE =
  'These results are finalized or belong to a closed academic year. Enter a correction reason to change them.';
const CONCURRENT_MESSAGE = 'Some results were changed by someone else after you opened them. Reload to see the latest values.';

const ALL_ASSESSMENT_FIELDS: readonly AssessmentField[] = [
  'monthlyExamTest1',
  'quantityOfHeatAssignments',
  'electrostaticsAssignments',
  'physicsNotebookAssessments',
  'physicsTextbookAssessments',
  'capacitorsNotesAssessments',
  'propertiesOfMatterAssignment',
  'heatAndTemperatureAssignment',
];

/**
 * Single place where marks are written. Every write:
 *  - checks the teacher is assigned to the section (server-side authorization),
 *  - verifies each student really belongs to that section and academic year,
 *  - validates marks against the class assessment maxima / the examination's configured maximum,
 *  - runs in ONE transaction with row locks, so concurrent saves cannot interleave,
 *  - uses optimistic versions, so a stale screen can never silently overwrite newer data,
 *  - refuses to touch finalized results or closed years unless an explicit correction reason is given,
 *  - writes a before/after audit entry per changed record in the same transaction.
 */
@Injectable()
export class MarksService {
  private readonly logger = new Logger('Marks');

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly scope: TeacherScopeService,
    private readonly audit: AuditService,
    private readonly state: PostgresStateService,
    private readonly events: EventsService,
  ) {}

  // ------------------------------------------------------------------------------------------------------------
  // Assessments (class-specific categories, total 30 marks)
  // ------------------------------------------------------------------------------------------------------------
  async saveAssessments(auth: AuthContext, dto: AssessmentSaveDto): Promise<SaveResult> {
    await this.scope.assertSection(auth, dto.sectionId);
    const result = await this.guard(() =>
      this.dataSource.transaction(async (m) => {
        const year = await this.getYear(m, dto.academicYearId);
        const section = await m.findOneByOrFail(Section, { id: dto.sectionId });

        const [sectionClass] = (await m.query(
          `SELECT c.grade_level
             FROM sections s
             JOIN classes c ON c.id = s.class_id
            WHERE s.id = $1`,
          [dto.sectionId],
        )) as Array<{ grade_level: number }>;

        const classId = Number(sectionClass?.grade_level);
        const categories = getAssessmentCategories(classId);
        const fields = getAssessmentFields(classId);
        const maxTotal = getAssessmentMaxTotal(classId);

        const invalidFields = dto.entries.flatMap((entry, i) =>
          ALL_ASSESSMENT_FIELDS.flatMap((field) =>
            !fields.includes(field) && entry[field] !== undefined && entry[field] !== null
              ? [{ path: `entries.${i}.${field}`, message: 'This category is not available for this class' }]
              : [],
          ),
        );

        const tooHigh = dto.entries.flatMap((entry, i) =>
          fields.flatMap((field) => {
            const value = entry[field];
            const category = categories.find((item) => item.field === field);
            return value !== undefined && value !== null && category && value > category.maxMarks
              ? [{ path: `entries.${i}.${field}`, message: `The maximum for this category is ${category.maxMarks}` }]
              : [];
          }),
        );

        if (invalidFields.length || tooHigh.length) {
          throw Errors.validation([...invalidFields, ...tooHigh]);
        }

        const ids = dto.entries.map((e) => e.enrollmentId);
        const enrollments = await this.loadEnrollments(m, ids, dto.sectionId, year.id);

        const existing = await m
          .createQueryBuilder(AssessmentRecord, 'a')
          .setLock('pessimistic_write')
          .where('a.enrollmentId IN (:...ids) AND a.term = :term', { ids, term: dto.term })
          .getMany();
        const byEnrollment = new Map(existing.map((a) => [a.enrollmentId, a]));

        const conflicts: Array<{ enrollmentId: string; expectedVersion: number; currentVersion: number }> = [];
        const locked: string[] = [];
        const finalizedIncomplete: string[] = [];
        const plan: Array<{
          enrollmentId: string;
          current: AssessmentRecord | undefined;
          before: AssessmentScores;
          next: AssessmentScores;
          changed: AssessmentField[];
          isLocked: boolean;
        }> = [];

        for (const entry of dto.entries) {
          const current = byEnrollment.get(entry.enrollmentId);
          const currentVersion = current?.version ?? 0;
          if (entry.version !== currentVersion) {
            conflicts.push({ enrollmentId: entry.enrollmentId, expectedVersion: entry.version, currentVersion });
            continue;
          }

          const before = current ? this.scoresOf(current) : emptyScores(classId);
          const next: AssessmentScores = { ...before };
          const changed: AssessmentField[] = [];

          for (const field of fields) {
            const value = entry[field];
            if (value !== undefined && value !== before[field]) {
              next[field] = value;
              changed.push(field);
            }
          }

          if (!changed.length) continue;

          const isLocked = year.status === 'closed' || current?.status === 'finalized';
          if (isLocked && !dto.correctionReason) {
            locked.push(entry.enrollmentId);
            continue;
          }

          if (current?.status === 'finalized' && fields.some((field) => next[field] === null)) {
            finalizedIncomplete.push(entry.enrollmentId);
            continue;
          }

          plan.push({ enrollmentId: entry.enrollmentId, current, before, next, changed, isLocked });
        }

        if (conflicts.length) throw Errors.conflict(CONCURRENT_MESSAGE, { conflicts }, 'CONCURRENT_MODIFICATION');
        if (locked.length) throw Errors.conflict(LOCKED_MESSAGE, { enrollmentIds: locked }, 'RECORD_LOCKED');
        if (finalizedIncomplete.length) {
          throw new AppError(422, 'FINALIZED_MUST_STAY_COMPLETE', 'A finalized result cannot be left incomplete.', {
            enrollmentIds: finalizedIncomplete,
          });
        }

        const batchId = randomUUID();
        const audits: AuditEntry[] = [];
        const records: SaveResult['records'] = [];
        let created = 0;
        let updated = 0;
        let corrected = 0;

        for (const p of plan) {
          const info = enrollments.get(p.enrollmentId)!;
          let row: AssessmentRecord;
          if (p.current) {
            const version = p.current.version + 1;
            await m.update(AssessmentRecord, { id: p.current.id }, { ...p.next, version, updatedById: auth.userId });
            row = Object.assign(p.current, p.next, { version });
          } else {
            row = await m.save(
              AssessmentRecord,
              m.create(AssessmentRecord, {
                enrollmentId: p.enrollmentId,
                term: dto.term,
                ...p.next,
                status: 'entered',
                version: 1,
                updatedById: auth.userId,
              }),
            );
          }

          const action = p.isLocked ? 'assessment.correction' : p.current ? 'assessment.update' : 'assessment.create';
          if (p.isLocked) corrected++;
          else if (p.current) updated++;
          else created++;

          audits.push({
            actor: auth,
            action,
            entityType: 'assessment',
            entityId: row.id,
            batchId,
            academicYearId: year.id,
            sectionId: dto.sectionId,
            before: this.pick(p.before, p.changed, assessmentTotal(p.before, classId), classId),
            after: this.pick(p.next, p.changed, assessmentTotal(p.next, classId), classId),
            context: {
              studentId: info.student_id,
              fullName: info.full_name,
              sectionLabel: section.label,
              classId,
              assessmentMaxTotal: maxTotal,
              term: dto.term,
              academicYear: year.label,
            },
            reason: p.isLocked ? dto.correctionReason : null,
          });

          records.push({ enrollmentId: p.enrollmentId, id: row.id, version: row.version, status: row.status });
        }

        await this.audit.log(m, audits);

        return { created, updated, corrected, cleared: 0, unchanged: dto.entries.length - plan.length, records, yearId: year.id };
      }),
    );

    await this.afterWrite(result.yearId, dto.sectionId, 'assessment', dto.term);
    const { yearId: _ignored, ...publicResult } = result;
    return publicResult;
  }

  /** Locks every complete, not-yet-final record of one section + term. Incomplete records are reported, not touched. */
  async finalizeAssessments(auth: AuthContext, dto: FinalizeAssessmentsDto): Promise<FinalizeResult> {
    await this.scope.assertSection(auth, dto.sectionId);
    const result = await this.dataSource.transaction(async (m) => {
      const year = await this.getYear(m, dto.academicYearId);
      const section = await m.findOneByOrFail(Section, { id: dto.sectionId });

      const [sectionClass] = (await m.query(
        `SELECT c.grade_level
           FROM sections s
           JOIN classes c ON c.id = s.class_id
          WHERE s.id = $1`,
        [dto.sectionId],
      )) as Array<{ grade_level: number }>;

      const classId = Number(sectionClass?.grade_level);
      const fields = getAssessmentFields(classId);
      const columns = fields.map((field) => field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`));
      const completeCondition = columns.map((column) => `a."${column}" IS NOT NULL`).join(' AND ');
      const enteredCondition = columns.map((column) => `a."${column}" IS NOT NULL`).join(' OR ');

      const done: Array<{ id: string; enrollment_id: string; student_id: string; full_name: string }> = await m.query(
        `WITH upd AS (
           UPDATE assessments a
              SET status = 'finalized', finalized_at = now(), version = a.version + 1, updated_by_id = $4, updated_at = now()
             FROM enrollments e
            WHERE e.id = a.enrollment_id AND e.academic_year_id = $1 AND e.section_id = $2 AND a.term = $3
              AND a.status = 'entered'
              AND ${completeCondition}
          RETURNING a.id, a.enrollment_id)
         SELECT upd.id, upd.enrollment_id, s.student_id, s.full_name
           FROM upd JOIN enrollments e ON e.id = upd.enrollment_id JOIN students s ON s.id = e.student_id`,
        [dto.academicYearId, dto.sectionId, dto.term, auth.userId],
      );

      const batchId = randomUUID();
      await this.audit.log(
        m,
        done.map((r) => ({
          actor: auth,
          action: 'assessment.finalize',
          entityType: 'assessment',
          entityId: r.id,
          batchId,
          academicYearId: year.id,
          sectionId: dto.sectionId,
          before: { status: 'entered' },
          after: { status: 'finalized' },
          context: { studentId: r.student_id, fullName: r.full_name, sectionLabel: section.label, classId, term: dto.term, academicYear: year.label },
        })),
      );

      const [stats] = (await m.query(
        `SELECT (SELECT count(*) FROM enrollments WHERE academic_year_id = $1 AND section_id = $2) AS enrolled,
                -- a row whose applicable categories were all cleared is "missing", not an incomplete record
                count(a.id) FILTER (WHERE ${enteredCondition}) AS records,
                count(a.id) FILTER (WHERE a.status = 'finalized') AS finalized
           FROM enrollments e LEFT JOIN assessments a ON a.enrollment_id = e.id AND a.term = $3
          WHERE e.academic_year_id = $1 AND e.section_id = $2`,
        [dto.academicYearId, dto.sectionId, dto.term],
      )) as Array<{ enrolled: string; records: string; finalized: string }>;

      const enrolled = Number(stats!.enrolled);
      const records = Number(stats!.records);
      const finalized = Number(stats!.finalized);

      return {
        yearId: year.id,
        out: {
          finalized: done.length,
          alreadyFinalized: finalized - done.length,
          incomplete: records - finalized,
          missing: enrolled - records,
        } satisfies FinalizeResult,
      };
    });

    await this.afterWrite(result.yearId, dto.sectionId, 'assessment', dto.term);
    return result.out;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Examinations (maximum is configured per examination)
  // ------------------------------------------------------------------------------------------------------------
  async saveExamMarks(auth: AuthContext, examId: string, dto: ExamMarksSaveDto): Promise<SaveResult> {
    const head = await this.dataSource.getRepository(Examination).findOneBy({ id: examId });
    if (!head) throw Errors.notFound('Examination');
    await this.scope.assertSection(auth, head.sectionId);

    const result = await this.guard(() =>
      this.dataSource.transaction(async (m) => {
        // FOR SHARE blocks a concurrent change of the maximum while marks are being validated against it.
        const exam = await m.createQueryBuilder(Examination, 'x').setLock('pessimistic_read').where('x.id = :examId', { examId }).getOneOrFail();
        const year = await this.getYear(m, exam.academicYearId);
        const section = await m.findOneByOrFail(Section, { id: exam.sectionId });

        const tooHigh = dto.entries.flatMap((e, i) =>
          e.marks !== null && e.marks > exam.maxMarks
            ? [{ path: `entries.${i}.marks`, message: `The maximum for this examination is ${exam.maxMarks}` }]
            : [],
        );
        if (tooHigh.length) throw Errors.validation(tooHigh);

        const ids = dto.entries.map((e) => e.enrollmentId);
        const enrollments = await this.loadEnrollments(m, ids, exam.sectionId, exam.academicYearId);
        const existing = await m
          .createQueryBuilder(ExamMark, 'k')
          .setLock('pessimistic_write')
          .where('k.examinationId = :examId AND k.enrollmentId IN (:...ids)', { examId, ids })
          .getMany();
        const byEnrollment = new Map(existing.map((k) => [k.enrollmentId, k]));

        const conflicts: Array<{ enrollmentId: string; expectedVersion: number; currentVersion: number }> = [];
        const locked: string[] = [];
        const finalizedClear: string[] = [];
        const plan: Array<{ enrollmentId: string; current: ExamMark | undefined; marks: number | null; isLocked: boolean }> = [];

        for (const entry of dto.entries) {
          const current = byEnrollment.get(entry.enrollmentId);
          const currentVersion = current?.version ?? 0;
          if (entry.version !== currentVersion) {
            conflicts.push({ enrollmentId: entry.enrollmentId, expectedVersion: entry.version, currentVersion });
            continue;
          }
          if (entry.marks === null && !current) continue; // nothing to clear
          if (entry.marks !== null && current && current.marks === entry.marks) continue; // unchanged
          const isLocked = year.status === 'closed' || current?.status === 'finalized';
          if (isLocked && !dto.correctionReason) {
            locked.push(entry.enrollmentId);
            continue;
          }
          if (entry.marks === null && current?.status === 'finalized') {
            finalizedClear.push(entry.enrollmentId);
            continue;
          }
          plan.push({ enrollmentId: entry.enrollmentId, current, marks: entry.marks, isLocked });
        }

        if (conflicts.length) throw Errors.conflict(CONCURRENT_MESSAGE, { conflicts }, 'CONCURRENT_MODIFICATION');
        if (locked.length) throw Errors.conflict(LOCKED_MESSAGE, { enrollmentIds: locked }, 'RECORD_LOCKED');
        if (finalizedClear.length) {
          throw new AppError(422, 'FINALIZED_MARK_CANNOT_BE_CLEARED', 'A finalized mark can be corrected but not removed.', {
            enrollmentIds: finalizedClear,
          });
        }

        const batchId = randomUUID();
        const audits: AuditEntry[] = [];
        const records: SaveResult['records'] = [];
        let created = 0;
        let updated = 0;
        let corrected = 0;
        let cleared = 0;

        for (const p of plan) {
          const info = enrollments.get(p.enrollmentId)!;
          const context = {
            studentId: info.student_id,
            fullName: info.full_name,
            sectionLabel: section.label,
            term: exam.term,
            examName: exam.name,
            maxMarks: exam.maxMarks,
            academicYear: year.label,
          };
          const base = { actor: auth, entityType: 'exam_mark', batchId, academicYearId: year.id, sectionId: exam.sectionId, context };

          if (p.marks === null && p.current) {
            await m.delete(ExamMark, { id: p.current.id });
            cleared++;
            audits.push({ ...base, action: 'exam_mark.clear', entityId: p.current.id, before: { marks: p.current.marks }, after: { marks: null } });
            records.push({ enrollmentId: p.enrollmentId, id: null, version: 0, status: 'missing' });
            continue;
          }

          const marks = p.marks as number;
          const previousMarks = p.current ? p.current.marks : null; // read before the entity is updated below
          let row: ExamMark;
          if (p.current) {
            const version = p.current.version + 1;
            await m.update(ExamMark, { id: p.current.id }, { marks, version, updatedById: auth.userId });
            row = Object.assign(p.current, { marks, version });
          } else {
            row = await m.save(
              ExamMark,
              m.create(ExamMark, { examinationId: examId, enrollmentId: p.enrollmentId, marks, status: 'entered', version: 1, updatedById: auth.userId }),
            );
          }

          const action = p.isLocked ? 'exam_mark.correction' : p.current ? 'exam_mark.update' : 'exam_mark.create';
          if (p.isLocked) corrected++;
          else if (p.current) updated++;
          else created++;

          audits.push({
            ...base,
            action,
            entityId: row.id,
            before: { marks: previousMarks },
            after: { marks },
            reason: p.isLocked ? dto.correctionReason : null,
          });
          records.push({ enrollmentId: p.enrollmentId, id: row.id, version: row.version, status: row.status });
        }

        await this.audit.log(m, audits);
        return { created, updated, corrected, cleared, unchanged: dto.entries.length - plan.length, records, yearId: year.id, sectionId: exam.sectionId, term: exam.term };
      }),
    );

    await this.afterWrite(result.yearId, result.sectionId, 'exam', result.term, examId);
    const { yearId: _y, sectionId: _s, term: _t, ...publicResult } = result;
    return publicResult;
  }

  async finalizeExam(auth: AuthContext, examId: string): Promise<FinalizeResult> {
    const head = await this.dataSource.getRepository(Examination).findOneBy({ id: examId });
    if (!head) throw Errors.notFound('Examination');
    await this.scope.assertSection(auth, head.sectionId);
    const result = await this.dataSource.transaction(async (m) => {
      const exam = await m.createQueryBuilder(Examination, 'x').setLock('pessimistic_read').where('x.id = :examId', { examId }).getOneOrFail();
      const year = await this.getYear(m, exam.academicYearId);
      const section = await m.findOneByOrFail(Section, { id: exam.sectionId });
      const done: Array<{ id: string; student_id: string; full_name: string; marks: string }> = await m.query(
        `WITH upd AS (
           UPDATE exam_marks SET status = 'finalized', finalized_at = now(), version = version + 1, updated_by_id = $2, updated_at = now()
            WHERE examination_id = $1 AND status = 'entered' RETURNING id, enrollment_id, marks)
         SELECT upd.id, upd.marks, s.student_id, s.full_name
           FROM upd JOIN enrollments e ON e.id = upd.enrollment_id JOIN students s ON s.id = e.student_id`,
        [examId, auth.userId],
      );

      const batchId = randomUUID();
      await this.audit.log(
        m,
        done.map((r) => ({
          actor: auth,
          action: 'exam_mark.finalize',
          entityType: 'exam_mark',
          entityId: r.id,
          batchId,
          academicYearId: year.id,
          sectionId: exam.sectionId,
          before: { status: 'entered' },
          after: { status: 'finalized', marks: Number(r.marks) },
          context: { studentId: r.student_id, fullName: r.full_name, sectionLabel: section.label, term: exam.term, examName: exam.name, academicYear: year.label },
        })),
      );

      const [stats] = (await m.query(
        `SELECT (SELECT count(*) FROM enrollments WHERE academic_year_id = $2 AND section_id = $3) AS enrolled,
                count(*) AS records, count(*) FILTER (WHERE status = 'finalized') AS finalized
           FROM exam_marks WHERE examination_id = $1`,
        [examId, exam.academicYearId, exam.sectionId],
      )) as Array<{ enrolled: string; records: string; finalized: string }>;

      const enrolled = Number(stats!.enrolled);
      const records = Number(stats!.records);
      const finalized = Number(stats!.finalized);

      return {
        yearId: year.id,
        sectionId: exam.sectionId,
        term: exam.term,
        out: { finalized: done.length, alreadyFinalized: finalized - done.length, incomplete: records - finalized, missing: enrolled - records } satisfies FinalizeResult,
      };
    });

    await this.afterWrite(result.yearId, result.sectionId, 'exam', result.term, examId);
    return result.out;
  }

  // ------------------------------------------------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------------------------------------------------
  private async getYear(m: EntityManager, id: string): Promise<AcademicYear> {
    const year = await m.findOneBy(AcademicYear, { id });
    if (!year) throw Errors.notFound('Academic year');
    return year;
  }

  /** Every student must be enrolled in exactly this section and academic year; otherwise nothing is saved. */
  private async loadEnrollments(m: EntityManager, ids: string[], sectionId: string, yearId: string) {
    const rows: EnrollmentInfo[] = await m.query(
      `SELECT e.id, s.student_id, s.full_name, e.section_id, e.academic_year_id
         FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.id = ANY($1::uuid[])`,
      [ids],
    );
    const map = new Map(rows.map((r) => [r.id, r]));
    const strangers = ids.filter((id) => {
      const r = map.get(id);
      return !r || r.section_id !== sectionId || r.academic_year_id !== yearId;
    });
    if (strangers.length) {
      throw new AppError(422, 'ENROLLMENT_MISMATCH', 'Some students do not belong to this section and academic year.', {
        enrollmentIds: strangers,
      });
    }
    return map;
  }

  private scoresOf(a: AssessmentRecord): AssessmentScores {
    return {
      monthlyExamTest1: a.monthlyExamTest1,
      quantityOfHeatAssignments: a.quantityOfHeatAssignments,
      electrostaticsAssignments: a.electrostaticsAssignments,
      physicsNotebookAssessments: a.physicsNotebookAssessments,
      physicsTextbookAssessments: a.physicsTextbookAssessments,
      capacitorsNotesAssessments: a.capacitorsNotesAssessments,
      propertiesOfMatterAssignment: a.propertiesOfMatterAssignment,
      heatAndTemperatureAssignment: a.heatAndTemperatureAssignment,
    };
  }

  private pick(
    scores: AssessmentScores,
    fields: readonly AssessmentField[],
    total: number | null,
    classId: number,
  ): Record<string, unknown> {
    return {
      ...Object.fromEntries(fields.map((field) => [field, scores[field]])),
      total,
      max: getAssessmentMaxTotal(classId),
      state: assessmentState(scores, false, classId),
    };
  }

  /** A unique violation here means two saves raced to create the same record. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof QueryFailedError && (e.driverError as { code?: string } | undefined)?.code === '23505') {
        throw Errors.conflict(CONCURRENT_MESSAGE, undefined, 'CONCURRENT_MODIFICATION');
      }
      throw e;
    }
  }

  /** After commit: drop cached analytics and tell open dashboards. Failures here must never fail the save. */
  private async afterWrite(yearId: string, sectionId: string, kind: 'assessment' | 'exam', term: number, examId?: string) {
    try {
      await this.state.invalidate(`year:${yearId}`);
    } catch (e) {
      this.logger.warn(`Cache invalidation failed: ${(e as Error).message}`);
    }
    this.events.publish({ type: 'marks.changed', academicYearId: yearId, sectionId, kind, term, examId, at: new Date().toISOString() });
  }
}
