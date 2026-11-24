
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { getAssessmentMaxTotal } from '../assessments/assessment-categories';
import { Errors } from '../common/errors';
import type { AuthContext, Term } from '../common/types';
import { TERM_LABELS } from '../common/types';
import { PostgresStateService } from '../database/postgres-state.service';
import { assessmentPercent, assessmentState, assessmentTotal, byName, isCounted, percentOf, rankDescending } from '../results/calculations';
import { ResultsService } from '../results/results.service';
import { computeStudentResults } from '../results/student-results';
import { TeacherScopeService } from '../teachers/teachers.service';

export interface RankingQuery {
  academicYearId: string;
  sectionId: string;
  scope: 'section' | 'class';
  kind: 'index' | 'assessment' | 'exam';
  term?: Term;
  examId?: string;
}

export interface RankedStudent {
  rank: number;
  enrollmentId: string;
  studentId: string;
  fullName: string;
  sectionLabel: string;
  marks: number | null;
  max: number | null;
  percent: number;
}

export interface RankingResult {
  kind: RankingQuery['kind'];
  scope: RankingQuery['scope'];
  title: string;
  context: string;
  sections: string[];
  items: RankedStudent[];
  /** students in scope who have no (complete) result yet: they are not ranked, and are never counted as zero */
  unranked: Array<{ enrollmentId: string; studentId: string; fullName: string; sectionLabel: string }>;
}

/**
 * Rankings are always computed inside an explicit academic context: one academic year, and either one section or
 * all of the teacher's sections of that class, for one assessment term, one examination, or the monitoring index.
 * Standard competition ranking is used (1, 2, 2, 4) and only students with a complete result are ranked.
 */
@Injectable()
export class RankingsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly results: ResultsService,
    private readonly scope: TeacherScopeService,
    private readonly state: PostgresStateService,
  ) {}

  async rank(auth: AuthContext, q: RankingQuery): Promise<RankingResult> {
    await this.scope.assertSection(auth, q.sectionId);
    const [year] = (await this.dataSource.query(`SELECT label FROM academic_years WHERE id = $1`, [q.academicYearId])) as Array<{ label: string }>;
    if (!year) throw Errors.notFound('Academic year');

    let sections: Array<{ id: string; label: string; classId: number }>;
    if (q.scope === 'section') {
      sections = await this.dataSource.query(
        `SELECT s.id, s.label, c.grade_level AS "classId"
         FROM sections s
         JOIN classes c ON c.id = s.class_id
         WHERE s.id = $1`,
        [q.sectionId],
      );
    } else {
      const mine = await this.scope.sectionIds(auth.userId);
      sections = await this.dataSource.query(
        `SELECT s.id, s.label, c.grade_level AS "classId"
         FROM sections s
         JOIN classes c ON c.id = s.class_id
         WHERE s.class_id = (SELECT class_id FROM sections WHERE id = $1)
         AND s.id = ANY($2::uuid[])
         ORDER BY s.label`,
        [q.sectionId, mine],
      );
    }
    const key = `rank:${q.scope}:${q.kind}:${q.term ?? ''}:${q.examId ?? ''}:${sections.map((s) => s.id).join(',')}`;
    const body = await this.state.cached(`year:${q.academicYearId}`, key, 300, () => this.compute(q, sections, year.label));
    return body;
  }

  private async compute(q: RankingQuery, sections: Array<{ id: string; label: string; classId: number }>, yearLabel: string): Promise<RankingResult> {
    const data = await this.results.loadScope(q.academicYearId, sections.map((s) => s.id));
    type Candidate = { enrollmentId: string; studentId: string; fullName: string; sectionLabel: string; marks: number | null; max: number | null; percent: number };
    const candidates: Candidate[] = [];
    let title = '';
    let context = '';

    if (q.kind === 'index') {
      title = 'Performance index';
      context = 'Average of term averages. Only entered or finalized results count.';
      for (const r of computeStudentResults(data)) {
        if (r.overallIndex !== null) candidates.push({ ...pick(r), marks: null, max: null, percent: r.overallIndex });
      }
    } else if (q.kind === 'assessment') {
      const term = q.term as Term;
      title = `${TERM_LABELS[term]} assessment`;
      context = `Out of ${getAssessmentMaxTotal(sections[0].classId)}. Only complete assessments are ranked.`;
      const byEnrollment = new Map(data.assessments.filter((a) => a.term === term).map((a) => [a.enrollmentId, a]));
      for (const e of data.enrollments) {
        const a = byEnrollment.get(e.enrollmentId);
        if (!a || !isCounted(assessmentState(a.scores, a.status === 'finalized', e.classId))) continue;
        const total = assessmentTotal(a.scores, e.classId) as number;
        const max = getAssessmentMaxTotal(e.classId);
        candidates.push({ ...pick(e), marks: total, max, percent: assessmentPercent(total, e.classId) });
      }
    } else {
      const [ref] = (await this.dataSource.query(`SELECT id, section_id, term, name, academic_year_id FROM examinations WHERE id = $1`, [q.examId])) as Array<{
        id: string;
        section_id: string;
        term: number;
        name: string;
        academic_year_id: string;
      }>;
      if (!ref || ref.academic_year_id !== q.academicYearId) throw Errors.notFound('Examination');
      if (!sections.some((s) => s.id === ref.section_id)) throw Errors.badRequest('This examination does not belong to the selected section.');
      // class scope: the same exam (term + name) given to each of the class's sections
      const related = data.exams.filter((x) => (q.scope === 'section' ? x.examId === ref.id : x.term === ref.term && x.name.toLowerCase() === ref.name.toLowerCase()));
      title = ref.name;
      context = `${TERM_LABELS[ref.term as Term]}, ${yearLabel}. Ranked by marks as a percentage of each examination's own maximum.`;
      const examById = new Map(related.map((x) => [x.examId, x]));
      const bySectionExam = new Map(related.map((x) => [x.sectionId, x]));
      const enrolled = new Map(data.enrollments.map((e) => [e.enrollmentId, e]));
      for (const m of data.examMarks) {
        const exam = examById.get(m.examId);
        const e = enrolled.get(m.enrollmentId);
        if (!exam || !e || bySectionExam.get(e.sectionId)?.examId !== m.examId) continue;
        candidates.push({ ...pick(e), marks: m.marks, max: exam.maxMarks, percent: percentOf(m.marks, exam.maxMarks) });
      }
      // students of sections where this exam exists but who have no mark are "unranked"; sections without it are left out
      data.enrollments = data.enrollments.filter((e) => bySectionExam.has(e.sectionId));
    }

    const ranked = rankDescending(candidates, (c) => c.percent, byName);
    // only name the sections that actually contribute students (a class may include empty sections)
    const withStudents = sections.filter((s) => data.enrollments.some((e) => e.sectionId === s.id)).map((s) => s.label);
    const labelsWithStudents = withStudents.length ? withStudents : sections.map((s) => s.label);
    const rankedIds = new Set(candidates.map((c) => c.enrollmentId));
    return {
      kind: q.kind,
      scope: q.scope,
      title,
      context,
      sections: labelsWithStudents,
      items: ranked.map((r) => ({ rank: r.rank, ...r.item })),
      unranked: data.enrollments
        .filter((e) => !rankedIds.has(e.enrollmentId))
        .map((e) => ({ enrollmentId: e.enrollmentId, studentId: e.studentId, fullName: e.fullName, sectionLabel: e.sectionLabel })),
    };
  }
}

function pick(r: { enrollmentId: string; studentId: string; fullName: string; sectionLabel: string }) {
  return { enrollmentId: r.enrollmentId, studentId: r.studentId, fullName: r.fullName, sectionLabel: r.sectionLabel };
}
