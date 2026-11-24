
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Errors } from '../common/errors';
import type { AuthContext, ResultState, Term } from '../common/types';
import { TERM_LABELS } from '../common/types';
import {
  getAssessmentCategories,
  getAssessmentMaxTotal,
  type AssessmentField,
} from './assessment-categories';
import { assessmentPercent, assessmentState, assessmentTotal, isCounted, type AssessmentScores } from '../results/calculations';
import { AuditService } from '../security/audit.service';
import { TeacherScopeService } from '../teachers/teachers.service';
import { StudentsService } from '../students/students.service';

const num = (v: string | number | null): number | null => (v === null || v === undefined ? null : Number(v));

export interface AssessmentRowView {
  enrollmentId: string;
  studentId: string;
  fullName: string;
  scores: AssessmentScores;
  total: number | null;
  percent: number | null;
  state: ResultState;
  /** 0 when the student has no record yet; send this back when saving. */
  version: number;
  recordId: string | null;
  updatedAt: string | null;
}

@Injectable()
export class AssessmentsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly scope: TeacherScopeService,
    private readonly students: StudentsService,
    private readonly audit: AuditService,
  ) {}

  /** The fixed categories, configured separately for each class. */
  async listCategories(classId?: number) {
    const classIds = classId === undefined ? [2, 3] : [classId];

    const categories = classIds.flatMap((id) =>
      getAssessmentCategories(id).map((category) => ({
        classId: id,
        code: category.code,
        field: category.field,
        name: category.name,
        maxMarks: category.maxMarks,
        sortOrder: category.sortOrder,
      })),
    );

    return {
      categories,
      maxTotal: classId === undefined ? 30 : getAssessmentMaxTotal(classId),
    };
  }

  async sheet(
    auth: AuthContext,
    q: { academicYearId: string; sectionId: string; term: Term; state?: ResultState; search?: string },
  ) {
    await this.scope.assertSection(auth, q.sectionId);

    const [year] = (await this.dataSource.query(
      `SELECT id, label, status FROM academic_years WHERE id = $1`,
      [q.academicYearId],
    )) as Array<{
      id: string;
      label: string;
      status: 'planned' | 'active' | 'closed';
    }>;

    if (!year) throw Errors.notFound('Academic year');

    const [section] = (await this.dataSource.query(
      `SELECT s.id, s.label, c.grade_level
         FROM sections s
         JOIN classes c ON c.id = s.class_id
        WHERE s.id = $1`,
      [q.sectionId],
    )) as Array<{ id: string; label: string; grade_level: number }>;

    if (!section) throw Errors.notFound('Section');

    const classId = Number(section.grade_level);
    const categories = getAssessmentCategories(classId);
    const fields = categories.map((category) => category.field);
    const maxTotal = getAssessmentMaxTotal(classId);

    const rows: Array<{
      enrollment_id: string;
      student_id: string;
      full_name: string;
      assessment_id: string | null;
      monthly_exam_test_1: string | null;
      quantity_of_heat_assignments: string | null;
      electrostatics_assignments: string | null;
      physics_notebook_assessments: string | null;
      physics_textbook_assessments: string | null;
      capacitors_notes_assessments: string | null;
      properties_of_matter_assignment: string | null;
      heat_and_temperature_assignment: string | null;
      status: 'entered' | 'finalized' | null;
      version: number | null;
      updated_at: Date | null;
    }> = await this.dataSource.query(
      `SELECT e.id AS enrollment_id, s.student_id, s.full_name,
              a.id AS assessment_id,
              a.monthly_exam_test_1,
              a.quantity_of_heat_assignments,
              a.electrostatics_assignments,
              a.physics_notebook_assessments,
              a.physics_textbook_assessments,
              a.capacitors_notes_assessments,
              a.properties_of_matter_assignment,
              a.heat_and_temperature_assignment,
              a.status, a.version, a.updated_at
         FROM enrollments e
         JOIN students s ON s.id = e.student_id
         LEFT JOIN assessments a ON a.enrollment_id = e.id AND a.term = $3
        WHERE e.academic_year_id = $1 AND e.section_id = $2
        ORDER BY s.full_name, s.student_id`,
      [q.academicYearId, q.sectionId, q.term],
    );

    const all: AssessmentRowView[] = rows.map((r) => {
      const scores: AssessmentScores = {
        monthlyExamTest1: num(r.monthly_exam_test_1),
        quantityOfHeatAssignments: num(r.quantity_of_heat_assignments),
        electrostaticsAssignments: num(r.electrostatics_assignments),
        physicsNotebookAssessments: num(r.physics_notebook_assessments),
        physicsTextbookAssessments: num(r.physics_textbook_assessments),
        capacitorsNotesAssessments: num(r.capacitors_notes_assessments),
        propertiesOfMatterAssignment: num(r.properties_of_matter_assignment),
        heatAndTemperatureAssignment: num(r.heat_and_temperature_assignment),
      };

      const state = assessmentState(scores, r.status === 'finalized', classId);
      const total = assessmentTotal(scores, classId);

      return {
        enrollmentId: r.enrollment_id,
        studentId: r.student_id,
        fullName: r.full_name,
        scores,
        total,
        percent: isCounted(state) && total !== null ? assessmentPercent(total, classId) : null,
        state,
        version: r.version ?? 0,
        recordId: r.assessment_id,
        updatedAt: r.updated_at ? r.updated_at.toISOString() : null,
      };
    });

    const count = (s: ResultState) => all.filter((r) => r.state === s).length;
    const needle = q.search?.toLowerCase();

    const filtered = all.filter(
      (r) => (!q.state || r.state === q.state) && (!needle || r.fullName.toLowerCase().includes(needle) || r.studentId.toLowerCase().includes(needle)),
    );

    return {
      academicYear: year,
      section: { id: section.id, label: section.label },
      classId,
      term: q.term,
      termLabel: TERM_LABELS[q.term],
      /** In a closed year every change needs a correction reason. */
      locked: year.status === 'closed',
      maxTotal,
      categories: categories.map((category) => ({
        code: category.code,
        field: category.field,
        name: category.name,
        maxMarks: category.maxMarks,
      })),
      summary: {
        students: all.length,
        missing: count('missing'),
        partial: count('partial'),
        entered: count('entered'),
        finalized: count('finalized'),
      },
      rows: filtered,
    };
  }

  /** Change history of one student's assessment for a term (from the audit trail). */
  async history(auth: AuthContext, enrollmentId: string, term: Term) {
    await this.students.assertAccess(auth, enrollmentId);

    const [record] = (await this.dataSource.query(
      `SELECT id FROM assessments WHERE enrollment_id = $1 AND term = $2`,
      [enrollmentId, term],
    )) as Array<{ id: string }>;

    return record ? this.audit.history('assessment', record.id) : [];
  }
}
