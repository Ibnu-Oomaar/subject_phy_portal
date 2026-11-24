
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Errors } from '../common/errors';
import type { AuthContext, Term } from '../common/types';
import { TERM_LABELS } from '../common/types';
import { StudentsService, type EnrollmentContext } from '../students/students.service';
import { TeacherScopeService } from '../teachers/teachers.service';
import { assessmentState, type AssessmentScores, type PerformanceFlags, type Trend } from './calculations';
import { RESULTS_CONFIG } from './results.config';
import { computeStudentResults, type AssessmentRow, type ExamMarkRow, type ExamRow, type ScopeData, type StudentResult, type TermResult } from './student-results';

const num = (v: string | number | null): number | null => (v === null || v === undefined ? null : Number(v));

export interface StudentProfile {
  student: { enrollmentId: string; studentId: string; fullName: string };
  academicYear: { id: string; label: string; status: 'planned' | 'active' | 'closed' };
  section: { id: string; label: string };
  className: string;
  terms: TermResult[];
  /** Monitoring index (mean of term means). It is NOT a final grade; see results.config.ts. */
  overallIndex: number | null;
  trend: Trend;
  trendDelta: number | null;
  /** only present in the teacher's view */
  flags?: PerformanceFlags;
  /** chart series: the index of each term that has results */
  progress: Array<{ term: Term; label: string; index: number | null }>;
  /** the same student in other academic years (only the years the viewer is allowed to see) */
  history: Array<{
    enrollmentId: string;
    academicYearId: string;
    academicYearLabel: string;
    sectionLabel: string;
    overallIndex: number | null;
    termIndexes: Array<{ term: Term; index: number | null }>;
  }>;
  basis?: { description: string; thresholds: typeof RESULTS_CONFIG.thresholds };
}

@Injectable()
export class ResultsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly students: StudentsService,
    private readonly scope: TeacherScopeService,
  ) {}

  /** Loads everything needed to compute results for all students of the given sections in one academic year. */
  async loadScope(yearId: string, sectionIds: string[]): Promise<ScopeData> {
    if (!sectionIds.length) return { enrollments: [], assessments: [], exams: [], examMarks: [] };
    const [enrollments, assessments, exams, examMarks] = await Promise.all([
      this.dataSource.query(
        `SELECT e.id AS enrollment_id, s.id AS student_uuid, s.student_id, s.full_name,
                sec.id AS section_id, sec.label AS section_label, c.grade_level
           FROM enrollments e
           JOIN students s ON s.id = e.student_id
           JOIN sections sec ON sec.id = e.section_id
           JOIN classes c ON c.id = sec.class_id
          WHERE e.academic_year_id = $1 AND e.section_id = ANY($2::uuid[])
          ORDER BY sec.label, s.full_name, s.student_id`,
        [yearId, sectionIds],
      ),
      this.dataSource.query(
        `SELECT a.enrollment_id, a.term,
                a.monthly_exam_test_1,
                a.quantity_of_heat_assignments,
                a.electrostatics_assignments,
                a.physics_notebook_assessments,
                a.physics_textbook_assessments,
                a.capacitors_notes_assessments,
                a.properties_of_matter_assignment,
                a.heat_and_temperature_assignment,
                a.status
           FROM assessments a
           JOIN enrollments e ON e.id = a.enrollment_id
          WHERE e.academic_year_id = $1 AND e.section_id = ANY($2::uuid[])`,
        [yearId, sectionIds],
      ),
      this.dataSource.query(
        `SELECT id, section_id, term, name, max_marks, to_char(exam_date, 'YYYY-MM-DD') AS exam_date
           FROM examinations WHERE academic_year_id = $1 AND section_id = ANY($2::uuid[])`,
        [yearId, sectionIds],
      ),
      this.dataSource.query(
        `SELECT m.examination_id, m.enrollment_id, m.marks, m.status
           FROM exam_marks m JOIN examinations x ON x.id = m.examination_id
          WHERE x.academic_year_id = $1 AND x.section_id = ANY($2::uuid[])`,
        [yearId, sectionIds],
      ),
    ]);
    return this.shape(enrollments, assessments, exams, examMarks);
  }

  /** Same data, but for specific enrollments (used for one student's profile and history across years). */
  async loadForEnrollments(enrollmentIds: string[]): Promise<ScopeData> {
    if (!enrollmentIds.length) return { enrollments: [], assessments: [], exams: [], examMarks: [] };
    const [enrollments, assessments, exams, examMarks] = await Promise.all([
      this.dataSource.query(
        `SELECT e.id AS enrollment_id, s.id AS student_uuid, s.student_id, s.full_name,
                sec.id AS section_id, sec.label AS section_label, c.grade_level
           FROM enrollments e
           JOIN students s ON s.id = e.student_id
           JOIN sections sec ON sec.id = e.section_id
           JOIN classes c ON c.id = sec.class_id
          WHERE e.id = ANY($1::uuid[])`,
        [enrollmentIds],
      ),
      this.dataSource.query(
        `SELECT enrollment_id, term,
                monthly_exam_test_1,
                quantity_of_heat_assignments,
                electrostatics_assignments,
                physics_notebook_assessments,
                physics_textbook_assessments,
                capacitors_notes_assessments,
                properties_of_matter_assignment,
                heat_and_temperature_assignment,
                status
           FROM assessments WHERE enrollment_id = ANY($1::uuid[])`,
        [enrollmentIds],
      ),
      this.dataSource.query(
        `SELECT x.id, x.section_id, x.term, x.name, x.max_marks, to_char(x.exam_date, 'YYYY-MM-DD') AS exam_date
           FROM examinations x
          WHERE EXISTS (SELECT 1 FROM enrollments e WHERE e.id = ANY($1::uuid[])
                         AND e.academic_year_id = x.academic_year_id AND e.section_id = x.section_id)`,
        [enrollmentIds],
      ),
      this.dataSource.query(`SELECT examination_id, enrollment_id, marks, status FROM exam_marks WHERE enrollment_id = ANY($1::uuid[])`, [enrollmentIds]),
    ]);
    return this.shape(enrollments, assessments, exams, examMarks);
  }

  async sectionResults(yearId: string, sectionIds: string[]): Promise<StudentResult[]> {
    return computeStudentResults(await this.loadScope(yearId, sectionIds));
  }

  /** The teacher's view of one student. */
  async teacherProfile(auth: AuthContext, enrollmentId: string): Promise<StudentProfile> {
    const ctx = await this.students.assertAccess(auth, enrollmentId);
    const allowed = new Set(await this.scope.sectionIds(auth.userId));
    return this.buildProfile(ctx, { forStudent: false, canSeeSection: (id) => allowed.has(id) });
  }

  /** The student's own view: only their data, and only results in a visible state. */
  async studentProfile(studentUuid: string, academicYearId?: string): Promise<StudentProfile | null> {
    const enrollments = await this.students.enrollmentsOfStudent(studentUuid);
    if (!enrollments.length) return null;
    const ctx = academicYearId
      ? enrollments.find((e) => e.academicYearId === academicYearId)
      : (enrollments.find((e) => e.academicYearStatus === 'active') ?? enrollments[0]);
    if (!ctx) throw Errors.notFound('Academic year');
    return this.buildProfile(ctx, { forStudent: true, canSeeSection: () => true, enrollments });
  }

  async studentYears(studentUuid: string) {
    const enrollments = await this.students.enrollmentsOfStudent(studentUuid);
    return enrollments.map((e) => ({
      academicYearId: e.academicYearId,
      academicYearLabel: e.academicYearLabel,
      status: e.academicYearStatus,
      sectionLabel: e.sectionLabel,
    }));
  }

  private async buildProfile(
    ctx: EnrollmentContext,
    opts: { forStudent: boolean; canSeeSection: (sectionId: string) => boolean; enrollments?: EnrollmentContext[] },
  ): Promise<StudentProfile> {
    const all = opts.enrollments ?? (await this.students.enrollmentsOfStudent(ctx.studentUuid));
    const visible = all.filter((e) => e.enrollmentId === ctx.enrollmentId || opts.canSeeSection(e.sectionId));
    let data = await this.loadForEnrollments(visible.map((e) => e.enrollmentId));
    if (opts.forStudent) data = this.onlyVisibleStates(data);
    const results = new Map(computeStudentResults(data).map((r) => [r.enrollmentId, r]));
    const current = results.get(ctx.enrollmentId)!;
    const progress = current.terms.map((t) => ({ term: t.term, label: TERM_LABELS[t.term], index: t.index }));
    return {
      student: { enrollmentId: ctx.enrollmentId, studentId: ctx.studentId, fullName: ctx.fullName },
      academicYear: { id: ctx.academicYearId, label: ctx.academicYearLabel, status: ctx.academicYearStatus },
      section: { id: ctx.sectionId, label: ctx.sectionLabel },
      className: ctx.className,
      terms: current.terms,
      overallIndex: current.overallIndex,
      trend: current.trend,
      trendDelta: current.trendDelta,
      ...(opts.forStudent ? {} : { flags: current.flags, basis: this.basis() }),
      progress,
      history: visible
        .filter((e) => e.enrollmentId !== ctx.enrollmentId)
        .map((e) => {
          const r = results.get(e.enrollmentId)!;
          return {
            enrollmentId: e.enrollmentId,
            academicYearId: e.academicYearId,
            academicYearLabel: e.academicYearLabel,
            sectionLabel: e.sectionLabel,
            overallIndex: r.overallIndex,
            termIndexes: r.terms.map((t) => ({ term: t.term, index: t.index })),
          };
        }),
    };
  }

  basis() {
    return {
      description:
        'Performance index = the average of each term\'s average percentage. Only entered or finalized results count; missing results are skipped, never treated as zero. It is for monitoring only and is not a final grade.',
      thresholds: RESULTS_CONFIG.thresholds,
    };
  }

  /** Drops results the student is not allowed to see yet (see studentVisibleStates). */
  private onlyVisibleStates(data: ScopeData): ScopeData {
    const ok = new Set<string>(RESULTS_CONFIG.studentVisibleStates);
    const classIds = new Map(data.enrollments.map((e) => [e.enrollmentId, e.classId]));

    return {
      ...data,
      assessments: data.assessments.filter((a) => {
        const classId = classIds.get(a.enrollmentId);
        return classId !== undefined && ok.has(assessmentState(a.scores, a.status === 'finalized', classId));
      }),
      examMarks: data.examMarks.filter((m) => ok.has(m.status)),
    };
  }

  private shape(enrollments: any[], assessments: any[], exams: any[], examMarks: any[]): ScopeData {
    return {
      enrollments: enrollments.map((r) => ({
        enrollmentId: r.enrollment_id,
        studentUuid: r.student_uuid,
        studentId: r.student_id,
        fullName: r.full_name,
        sectionId: r.section_id,
        sectionLabel: r.section_label,
        classId: Number(r.grade_level),
      })),
      assessments: assessments.map(
        (r): AssessmentRow => ({
          enrollmentId: r.enrollment_id,
          term: Number(r.term),
          status: r.status,
          scores: {
            monthlyExamTest1: num(r.monthly_exam_test_1),
            quantityOfHeatAssignments: num(r.quantity_of_heat_assignments),
            electrostaticsAssignments: num(r.electrostatics_assignments),
            physicsNotebookAssessments: num(r.physics_notebook_assessments),
            physicsTextbookAssessments: num(r.physics_textbook_assessments),
            capacitorsNotesAssessments: num(r.capacitors_notes_assessments),
            propertiesOfMatterAssignment: num(r.properties_of_matter_assignment),
            heatAndTemperatureAssignment: num(r.heat_and_temperature_assignment),
          } satisfies AssessmentScores,
        }),
      ),
      exams: exams.map(
        (r): ExamRow => ({
          examId: r.id,
          sectionId: r.section_id,
          term: Number(r.term),
          name: r.name,
          maxMarks: Number(r.max_marks),
          examDate: r.exam_date,
        }),
      ),
      examMarks: examMarks.map(
        (r): ExamMarkRow => ({ examId: r.examination_id, enrollmentId: r.enrollment_id, marks: Number(r.marks), status: r.status }),
      ),
    };
  }
}
