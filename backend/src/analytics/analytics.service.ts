
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { getAssessmentCategories } from '../assessments/assessment-categories';
import { Errors } from '../common/errors';
import type { AuthContext, ResultState } from '../common/types';
import { TERMS, TERM_LABELS } from '../common/types';
import { PostgresStateService } from '../database/postgres-state.service';
import {
  assessmentPercent,
  assessmentState,
  assessmentTotal,
  byName,
  distribution,
  isCounted,
  mean,
  percentOf,
  rankDescending,
  summarize,
} from '../results/calculations';
import { RESULTS_CONFIG } from '../results/results.config';
import { ResultsService } from '../results/results.service';
import { computeStudentResults, type ScopeData, type StudentResult } from '../results/student-results';
import { AuditService } from '../security/audit.service';
import { TeacherScopeService } from '../teachers/teachers.service';

const CACHE_SECONDS = 300;

export interface PersonRef {
  enrollmentId: string;
  studentId: string;
  fullName: string;
  sectionLabel: string;
  index: number | null;
  trend: StudentResult['trend'];
  trendDelta: number | null;
}
const ref = (r: StudentResult): PersonRef => ({
  enrollmentId: r.enrollmentId,
  studentId: r.studentId,
  fullName: r.fullName,
  sectionLabel: r.sectionLabel,
  index: r.overallIndex,
  trend: r.trend,
  trendDelta: r.trendDelta,
});

const pct = (part: number, whole: number): number | null => (whole === 0 ? null : Math.round((part / whole) * 1000) / 10);

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly results: ResultsService,
    private readonly scope: TeacherScopeService,
    private readonly state: PostgresStateService,
    private readonly audit: AuditService,
  ) {}

  private async getYear(yearId: string) {
    const [year] = (await this.dataSource.query(`SELECT id, label, status FROM academic_years WHERE id = $1`, [yearId])) as Array<{
      id: string;
      label: string;
      status: 'planned' | 'active' | 'closed';
    }>;
    if (!year) throw Errors.notFound('Academic year');
    return year;
  }

  // ----------------------------------------------------------------------------------------------------------
  // Class / section performance
  // ----------------------------------------------------------------------------------------------------------
  async section(auth: AuthContext, yearId: string, sectionId: string) {
    await this.scope.assertSection(auth, sectionId);
    const year = await this.getYear(yearId);
    const [{ class_id: classId, grade_level: gradeLevel, label }] = (await this.dataSource.query(
      `SELECT s.class_id, c.grade_level, s.label FROM sections s JOIN classes c ON c.id = s.class_id WHERE s.id = $1`,
      [sectionId],
    )) as Array<{ class_id: string; grade_level: number; label: string }>;
    const mine = await this.scope.sectionIds(auth.userId);
    const classSections: Array<{ id: string; label: string }> = await this.dataSource.query(
      `SELECT id, label FROM sections WHERE class_id = $1 AND id = ANY($2::uuid[]) ORDER BY label`,
      [classId, mine],
    );
    const key = `section:${sectionId}:${classSections.map((s) => s.id).join(',')}`;
    const body = await this.state.cached(`year:${yearId}`, key, CACHE_SECONDS, () => this.buildSection(sectionId, label, classSections, yearId, gradeLevel));
    return { academicYear: year, ...body };
  }

  private async buildSection(sectionId: string, sectionLabel: string, classSections: Array<{ id: string; label: string }>, yearId: string, classId: number) {
    const data = await this.results.loadScope(yearId, classSections.map((s) => s.id));
    const everyone = computeStudentResults(data);
    const mine = everyone.filter((r) => r.sectionId === sectionId);
    const myIds = new Set(mine.map((r) => r.enrollmentId));
    const myData: ScopeData = {
      enrollments: data.enrollments.filter((e) => e.sectionId === sectionId),
      assessments: data.assessments.filter((a) => myIds.has(a.enrollmentId)),
      exams: data.exams.filter((x) => x.sectionId === sectionId),
      examMarks: data.examMarks.filter((m) => myIds.has(m.enrollmentId)),
    };

    const withIndex = mine.filter((r) => r.overallIndex !== null);
    const ranked = rankDescending(withIndex, (r) => r.overallIndex as number, byName);
    const indexes = withIndex.map((r) => r.overallIndex as number);

    // an empty section teaches us nothing, so class comparisons only include sections that have students
    const populated = classSections.filter((s) => everyone.some((r) => r.sectionId === s.id));
    const sectionAverages = populated.map((s) => {
      const idx = everyone.filter((r) => r.sectionId === s.id && r.overallIndex !== null).map((r) => r.overallIndex as number);
      return { sectionId: s.id, label: s.label, average: mean(idx), students: idx.length };
    });
    const classIndexes = everyone.filter((r) => r.overallIndex !== null).map((r) => r.overallIndex as number);

    const assessmentCategories = getAssessmentCategories(classId);
    const assessmentPerformance = TERMS.map((term) => {
      const records = myData.assessments
        .filter((a) => a.term === term)
        .map((a) => ({ a, state: assessmentState(a.scores, a.status === 'finalized', classId) }));
      const counted = records.filter((r) => isCounted(r.state));
      const totals = counted.map((r) => assessmentTotal(r.a.scores, classId) as number);
      const sum = summarize(totals);
      return {
        term,
        label: TERM_LABELS[term],
        enrolled: mine.length,
        entered: counted.length,
        finalized: records.filter((r) => r.state === 'finalized').length,
        missing: mine.length - counted.length,
        maxTotal: 30,
        averageTotal: sum.average,
        highestTotal: sum.highest,
        lowestTotal: sum.lowest,
        averagePercent: sum.average === null ? null : assessmentPercent(sum.average, classId),
        categories: assessmentCategories.map((c) => ({
          code: c.code,
          name: c.name,
          maxMarks: c.maxMarks,
          average: mean(counted.map((r) => r.a.scores[c.field]).filter((v): v is number => v !== null)),
        })),
      };
    });

    const examPerformance = myData.exams
      .slice()
      .sort((a, b) => a.term - b.term || (a.examDate ?? '').localeCompare(b.examDate ?? '') || a.name.localeCompare(b.name))
      .map((exam) => {
        const marks = myData.examMarks.filter((m) => m.examId === exam.examId);
        const sum = summarize(marks.map((m) => m.marks));
        return {
          examId: exam.examId,
          name: exam.name,
          term: exam.term,
          termLabel: TERM_LABELS[exam.term as 1 | 2 | 3],
          examDate: exam.examDate,
          maxMarks: exam.maxMarks,
          enrolled: mine.length,
          entered: marks.length,
          finalized: marks.filter((m) => m.status === 'finalized').length,
          missing: mine.length - marks.length,
          average: sum.average,
          averagePercent: sum.average === null ? null : percentOf(sum.average, exam.maxMarks),
          highest: sum.highest,
          lowest: sum.lowest,
        };
      });

    const termAverages = TERMS.map((term) => {
      const values = mine.map((r) => r.terms.find((t) => t.term === term)!.index).filter((v): v is number => v !== null);
      return { term, label: TERM_LABELS[term], average: mean(values), students: values.length };
    });

    return {
      section: { id: sectionId, label: sectionLabel },
      totals: { students: mine.length, withResults: withIndex.length, withoutResults: mine.length - withIndex.length },
      /** performance index of the section / of every section of this class that the teacher teaches */
      sectionAverage: { average: mean(indexes), highest: indexes.length ? Math.max(...indexes) : null, lowest: indexes.length ? Math.min(...indexes) : null, students: indexes.length },
      classAverage: { average: mean(classIndexes), students: classIndexes.length, sections: populated.map((s) => s.label) },
      sectionAverages,
      highestStudent: ranked[0] ? ref(ranked[0].item) : null,
      lowestStudent: ranked.length ? ref(ranked[ranked.length - 1]!.item) : null,
      ranking: ranked.map((r) => ({ rank: r.rank, ...ref(r.item) })),
      unranked: mine.filter((r) => r.overallIndex === null).map(ref),
      assessmentPerformance,
      examPerformance,
      termAverages,
      distribution: distribution(indexes),
      attention: {
        exceptional: withIndex.filter((r) => r.flags.exceptional).map(ref),
        low: withIndex.filter((r) => r.flags.low).map(ref),
        needsSupport: withIndex.filter((r) => r.flags.needsSupport).map(ref),
        improving: withIndex.filter((r) => r.flags.improving).map(ref),
        declining: withIndex.filter((r) => r.flags.declining).map(ref),
      },
      basis: this.results.basis(),
    };
  }

  // ----------------------------------------------------------------------------------------------------------
  // Teacher dashboard
  // ----------------------------------------------------------------------------------------------------------
  async dashboard(auth: AuthContext, yearId?: string) {
    const year = yearId ? await this.getYear(yearId) : await this.defaultYear();
    const assigned = await this.scope.sectionIds(auth.userId);
    if (!year) {
      return { academicYear: null, totals: { students: 0, sections: assigned.length }, empty: true };
    }
    const body = await this.state.cached(`year:${year.id}`, `dashboard:${[...assigned].sort().join(',')}`, CACHE_SECONDS, () => this.buildDashboard(year.id, assigned));
    // recent activity is personal and must always be fresh, so it is outside the cache
    const recentActivity = await this.audit.recentActivity(auth.userId, year.id, 8);
    return { academicYear: year, ...body, recentActivity };
  }

  private async defaultYear() {
    const [year] = (await this.dataSource.query(
      `SELECT id, label, status FROM academic_years ORDER BY (status = 'active') DESC, start_year DESC LIMIT 1`,
    )) as Array<{ id: string; label: string; status: 'planned' | 'active' | 'closed' }>;
    return year ?? null;
  }

  private async buildDashboard(yearId: string, sectionIds: string[]) {
    const data = await this.results.loadScope(yearId, sectionIds);
    const all = computeStudentResults(data);
    const sections: Array<{ id: string; label: string }> = await this.dataSource.query(`SELECT id, label FROM sections WHERE id = ANY($1::uuid[]) ORDER BY label`, [sectionIds]);
    const classIdByEnrollment = new Map(data.enrollments.map((e) => [e.enrollmentId, e.classId]));
    const assessmentStateOf = (a: ScopeData['assessments'][number]) =>
      assessmentState(a.scores, a.status === 'finalized', classIdByEnrollment.get(a.enrollmentId)!);

    // assessment completion per term
    const assessmentByTerm = TERMS.map((term) => {
      const records = data.assessments.filter((a) => a.term === term).map(assessmentStateOf);
      const counted = records.filter(isCounted).length;
      return {
        term,
        label: TERM_LABELS[term],
        expected: data.enrollments.length,
        entered: counted,
        finalized: records.filter((s) => s === 'finalized').length,
        percent: pct(counted, data.enrollments.length),
      };
    });
    const assessmentExpected = data.enrollments.length * TERMS.length;
    const assessmentEntered = assessmentByTerm.reduce((s, t) => s + t.entered, 0);

    // examination completion: a student is expected to have a mark in every examination of their section
    const enrolledBySection = new Map<string, number>();
    for (const e of data.enrollments) enrolledBySection.set(e.sectionId, (enrolledBySection.get(e.sectionId) ?? 0) + 1);
    const marksByExam = new Map<string, number>();
    for (const m of data.examMarks) marksByExam.set(m.examId, (marksByExam.get(m.examId) ?? 0) + 1);
    const examsOut = data.exams.map((x) => ({ ...x, enrolled: enrolledBySection.get(x.sectionId) ?? 0, entered: marksByExam.get(x.examId) ?? 0 }));
    const examByTerm = TERMS.map((term) => {
      const list = examsOut.filter((x) => x.term === term);
      const expected = list.reduce((s, x) => s + x.enrolled, 0);
      const entered = list.reduce((s, x) => s + x.entered, 0);
      return { term, label: TERM_LABELS[term], exams: list.length, expected, entered, percent: pct(entered, expected) };
    });
    const examExpected = examsOut.reduce((s, x) => s + x.enrolled, 0);
    const examEntered = examsOut.reduce((s, x) => s + x.entered, 0);

    const sectionRows = sections.map((s) => {
      const students = all.filter((r) => r.sectionId === s.id);
      const idx = students.map((r) => r.overallIndex).filter((v): v is number => v !== null);
      const aExpected = students.length * TERMS.length;
      const studentEnrollmentIds = new Set(students.map((st) => st.enrollmentId));
      const aEntered = data.assessments.filter((a) => studentEnrollmentIds.has(a.enrollmentId) && isCounted(assessmentStateOf(a))).length;
      const exams = examsOut.filter((x) => x.sectionId === s.id);
      return {
        sectionId: s.id,
        label: s.label,
        students: students.length,
        averageIndex: mean(idx),
        assessmentPercent: pct(aEntered, aExpected),
        examPercent: pct(exams.reduce((a, x) => a + x.entered, 0), exams.reduce((a, x) => a + x.enrolled, 0)),
        examinations: exams.length,
      };
    });

    const withIndex = all.filter((r) => r.overallIndex !== null);
    const ranked = rankDescending(withIndex, (r) => r.overallIndex as number, byName);

    return {
      totals: { students: data.enrollments.length, sections: sectionIds.length, sectionsWithStudents: sectionRows.filter((s) => s.students > 0).length },
      assessmentCompletion: { expected: assessmentExpected, entered: assessmentEntered, percent: pct(assessmentEntered, assessmentExpected), byTerm: assessmentByTerm },
      examCompletion: { examinations: examsOut.length, expected: examExpected, entered: examEntered, percent: pct(examEntered, examExpected), byTerm: examByTerm },
      sections: sectionRows,
      topStudents: ranked.slice(0, 5).map((r) => ({ rank: r.rank, ...ref(r.item) })),
      attention: withIndex
        .filter((r) => r.flags.needsSupport || r.flags.low)
        .sort((a, b) => (a.overallIndex as number) - (b.overallIndex as number))
        .slice(0, 8)
        .map((r) => ({ ...ref(r), needsSupport: r.flags.needsSupport, declining: r.flags.declining })),
      counts: {
        exceptional: withIndex.filter((r) => r.flags.exceptional).length,
        low: withIndex.filter((r) => r.flags.low).length,
        needsSupport: withIndex.filter((r) => r.flags.needsSupport).length,
        improving: withIndex.filter((r) => r.flags.improving).length,
        declining: withIndex.filter((r) => r.flags.declining).length,
      },
      thresholds: RESULTS_CONFIG.thresholds,
    };
  }
}
