import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type ExcelJS from 'exceljs';
import { DataSource } from 'typeorm';
import { AnalyticsService } from '../analytics/analytics.service';
import { ASSESSMENT_CATEGORIES, ASSESSMENT_MAX_TOTAL } from '../assessments/assessment-categories';
import { Errors } from '../common/errors';
import type { AuthContext, ResultState, Term } from '../common/types';
import { TERMS, TERM_LABELS } from '../common/types';
import { ExcelService, exportFilename, type CellValue, type ColumnDef } from '../excel/excel.service';
import { RankingsService } from '../rankings/rankings.service';
import { assessmentPercent, assessmentState, assessmentTotal, isCounted, mean, percentOf, summarize, type Trend } from '../results/calculations';
import { ResultsService } from '../results/results.service';
import { computeStudentResults, type ScopeData, type StudentResult } from '../results/student-results';
import { TeacherScopeService } from '../teachers/teachers.service';

export const EXPORT_TYPES = ['students', 'assessments', 'exam-marks', 'student-result', 'rankings', 'academic-year-report', 'class-performance'] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

export interface ExportQuery {
  academicYearId?: string;
  sectionId?: string;
  /** with a sectionId: only that section, or every section of its class that the teacher teaches */
  scope?: 'section' | 'class';
  term?: Term;
  examId?: string;
  enrollmentId?: string;
  kind?: 'index' | 'assessment' | 'exam';
}

export interface ExportFile {
  buffer: Buffer;
  fileName: string;
}

interface ScopedSection {
  id: string;
  label: string;
  className: string;
}
interface ResolvedScope {
  sections: ScopedSection[];
  ids: string[];
  /** human readable, e.g. "Section 1B", "Class 1 (1B, 1C)", "All sections (1B, 1C)" */
  description: string;
  /** safe short form for file names */
  fileLabel: string;
}
interface YearRow {
  id: string;
  label: string;
  status: 'planned' | 'active' | 'closed';
}

const STATE_LABEL: Record<ResultState, string> = { missing: 'Missing', partial: 'Partial', entered: 'Entered', finalized: 'Finalized' };
const TREND_LABEL: Record<Trend, string> = { improving: 'Improving', declining: 'Declining', steady: 'Steady', insufficient: 'Not enough data' };
const YEAR_STATUS_LABEL = { planned: 'Planned', active: 'Active', closed: 'Closed' } as const;

const today = () => new Date().toISOString().slice(0, 10);
const flagLabels = (f: StudentResult['flags']): string =>
  [f.exceptional && 'Exceptional', f.low && 'Low', f.needsSupport && 'Needs support', f.improving && 'Improving', f.declining && 'Declining'].filter(Boolean).join(', ');

const text = (header: string, key: string, width?: number): ColumnDef => ({ header, key, width, format: 'text' });
const marks = (header: string, key: string, width = 14): ColumnDef => ({ header, key, width, format: 'marks' });
const percent = (header: string, key: string, width = 14): ColumnDef => ({ header, key, width, format: 'percent' });
const int = (header: string, key: string, width = 12): ColumnDef => ({ header, key, width, format: 'int' });

/**
 * Excel exports. Every export is limited to the sections the teacher is assigned to, computed from the same
 * services the screens use (so a file can never disagree with the dashboard), and writes missing marks as blank
 * cells, never as 0. Partial assessments show their entered categories but no total or percentage.
 */
@Injectable()
export class ReportsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly excel: ExcelService,
    private readonly scope: TeacherScopeService,
    private readonly results: ResultsService,
    private readonly rankings: RankingsService,
    private readonly analytics: AnalyticsService,
  ) {}

  async export(auth: AuthContext, type: ExportType, q: ExportQuery): Promise<ExportFile> {
    switch (type) {
      case 'students':
        return this.students(auth, q);
      case 'assessments':
        return this.assessments(auth, q);
      case 'exam-marks':
        return this.examMarks(auth, q);
      case 'student-result':
        return this.studentResult(auth, q);
      case 'rankings':
        return this.rankingsReport(auth, q);
      case 'academic-year-report':
        return this.academicYearReport(auth, q);
      case 'class-performance':
        return this.classPerformance(auth, q);
    }
  }

  // ------------------------------------------------------------------------------------------------------
  // shared helpers
  // ------------------------------------------------------------------------------------------------------
  private async requireYear(q: ExportQuery): Promise<YearRow> {
    if (!q.academicYearId) throw Errors.badRequest('Choose an academic year for this export.', undefined, 'YEAR_REQUIRED');
    return this.getYear(q.academicYearId);
  }

  private async getYear(id: string): Promise<YearRow> {
    const [year] = (await this.dataSource.query(`SELECT id, label, status FROM academic_years WHERE id = $1`, [id])) as YearRow[];
    if (!year) throw Errors.notFound('Academic year');
    return year;
  }

  /** The sections an export covers: always a subset of the teacher's own sections. */
  private async resolveScope(auth: AuthContext, q: ExportQuery, opts: { sectionRequired: boolean }): Promise<ResolvedScope> {
    const mine = await this.scope.sectionIds(auth.userId);
    let sections: ScopedSection[];
    let description: string;
    let fileLabel: string;
    const load = (sql: string, params: unknown[]) =>
      this.dataSource
        .query(sql, params)
        .then((rows: Array<{ id: string; label: string; class_name: string }>) => rows.map((r) => ({ id: r.id, label: r.label, className: r.class_name })));

    if (!q.sectionId) {
      if (opts.sectionRequired) throw Errors.badRequest('Choose a section for this export.', undefined, 'SECTION_REQUIRED');
      sections = await load(`SELECT s.id, s.label, c.name AS class_name FROM sections s JOIN classes c ON c.id = s.class_id WHERE s.id = ANY($1::uuid[]) ORDER BY s.label`, [mine]);
      description = `All your sections (${sections.map((s) => s.label).join(', ') || 'none'})`;
      fileLabel = 'All-sections';
    } else {
      await this.scope.assertSection(auth, q.sectionId);
      if (q.scope === 'class') {
        sections = await load(
          `SELECT s.id, s.label, c.name AS class_name FROM sections s JOIN classes c ON c.id = s.class_id
            WHERE s.class_id = (SELECT class_id FROM sections WHERE id = $1) AND s.id = ANY($2::uuid[]) ORDER BY s.label`,
          [q.sectionId, mine],
        );
        const cls = sections[0]?.className ?? 'Class';
        description = `${cls} (${sections.map((s) => s.label).join(', ')})`;
        fileLabel = cls.replace(/\s+/g, '-');
      } else {
        sections = await load(`SELECT s.id, s.label, c.name AS class_name FROM sections s JOIN classes c ON c.id = s.class_id WHERE s.id = $1`, [q.sectionId]);
        description = `Section ${sections[0]?.label ?? ''}`;
        fileLabel = sections[0]?.label ?? 'Section';
      }
    }
    return { sections, ids: sections.map((s) => s.id), description, fileLabel };
  }

  private subtitle(year: YearRow | null, scope: ResolvedScope, extra?: string): string {
    return [year ? `Academic year ${year.label}` : 'All academic years', scope.description, extra, `Exported ${today()}`].filter(Boolean).join('  |  ');
  }

  private async finish(wb: ExcelJS.Workbook, ...nameParts: string[]): Promise<ExportFile> {
    return { buffer: await this.excel.toBuffer(wb), fileName: exportFilename('Physics', ...nameParts) };
  }

  // ------------------------------------------------------------------------------------------------------
  // 1. students (all students / one class / one section; one academic year or all of them)
  // ------------------------------------------------------------------------------------------------------
  private async students(auth: AuthContext, q: ExportQuery): Promise<ExportFile> {
    const scope = await this.resolveScope(auth, q, { sectionRequired: false });
    const year = q.academicYearId ? await this.getYear(q.academicYearId) : null;
    const rows: Array<{ student_id: string; full_name: string; class_name: string; label: string; year_label: string; status: keyof typeof YEAR_STATUS_LABEL }> =
      await this.dataSource.query(
        `SELECT s.student_id, s.full_name, c.name AS class_name, sec.label, y.label AS year_label, y.status
           FROM enrollments e
           JOIN students s ON s.id = e.student_id
           JOIN sections sec ON sec.id = e.section_id
           JOIN classes c ON c.id = sec.class_id
           JOIN academic_years y ON y.id = e.academic_year_id
          WHERE e.section_id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR e.academic_year_id = $2::uuid)
          ORDER BY y.start_year DESC, sec.label, s.full_name, s.student_id`,
        [scope.ids, year?.id ?? null],
      );
    const wb = this.excel.createWorkbook();
    this.excel.addTable(wb, 'Students', {
      title: 'Students',
      subtitle: this.subtitle(year, scope),
      columns: [text('Student ID', 'studentId', 16), text('Student Name', 'fullName', 34), text('Class', 'className', 12), text('Section', 'section', 10), text('Academic Year', 'year', 16), text('Year Status', 'status', 14)],
      rows: rows.map((r) => ({ studentId: r.student_id, fullName: r.full_name, className: r.class_name, section: r.label, year: r.year_label, status: YEAR_STATUS_LABEL[r.status] })),
      freezeColumns: 2,
    });
    return this.finish(wb, 'students', year?.label ?? 'all-years', scope.fileLabel);
  }

  // ------------------------------------------------------------------------------------------------------
  // 2. continuous assessment marks (one sheet per term)
  // ------------------------------------------------------------------------------------------------------
  private async assessments(auth: AuthContext, q: ExportQuery): Promise<ExportFile> {
    const year = await this.requireYear(q);
    const scope = await this.resolveScope(auth, q, { sectionRequired: false });
    const data = await this.results.loadScope(year.id, scope.ids);
    const byKey = new Map(data.assessments.map((a) => [`${a.enrollmentId}:${a.term}`, a]));
    const terms: readonly Term[] = q.term ? [q.term] : TERMS;
    const wb = this.excel.createWorkbook();

    for (const term of terms) {
      const rows = data.enrollments.map((e) => {
        const a = byKey.get(`${e.enrollmentId}:${term}`);
        const state: ResultState = a ? assessmentState(a.scores, a.status === 'finalized') : 'missing';
        const counted = isCounted(state);
        const total = a && counted ? assessmentTotal(a.scores) : null;
        const row: Record<string, CellValue> = {
          studentId: e.studentId,
          fullName: e.fullName,
          section: e.sectionLabel,
          total,
          percent: total === null ? null : assessmentPercent(total),
          state: STATE_LABEL[state],
        };
        for (const c of ASSESSMENT_CATEGORIES) row[c.field] = a ? a.scores[c.field] : null; // blank, never 0
        return row;
      });
      this.excel.addTable(wb, TERM_LABELS[term], {
        title: `${TERM_LABELS[term]} assessment marks`,
        subtitle: this.subtitle(year, scope, 'Blank = not entered. Totals and percentages appear only for complete assessments.'),
        columns: [
          text('Student ID', 'studentId', 16),
          text('Student Name', 'fullName', 32),
          text('Section', 'section', 10),
          ...ASSESSMENT_CATEGORIES.map((c) => marks(`${c.name} (/${c.maxMarks})`, c.field, 18)),
          marks(`Total (/${ASSESSMENT_MAX_TOTAL})`, 'total'),
          percent('Percentage (%)', 'percent'),
          text('Status', 'state', 12),
        ],
        rows,
        freezeColumns: 2,
      });
    }
    return this.finish(wb, 'assessment-marks', year.label, scope.fileLabel, q.term ? `T${q.term}` : '');
  }

  // ------------------------------------------------------------------------------------------------------
  // 3. examination marks for one term (long format: one row per student per examination)
  // ------------------------------------------------------------------------------------------------------
  private async examMarks(auth: AuthContext, q: ExportQuery): Promise<ExportFile> {
    if (!q.term && !q.examId) throw Errors.badRequest('Choose a term (or an examination) for this export.', undefined, 'TERM_REQUIRED');
    const year = await this.requireYear(q);
    const scope = await this.resolveScope(auth, q, { sectionRequired: false });
    const data = await this.results.loadScope(year.id, scope.ids);

    let exams = data.exams.filter((x) => (q.term ? x.term === q.term : true) && (q.examId ? x.examId === q.examId : true));
    if (q.examId && !exams.length) throw Errors.notFound('Examination');
    const term = (q.term ?? exams[0]?.term) as Term;
    const sectionOrder = new Map(scope.sections.map((s, i) => [s.id, i]));
    exams = exams.slice().sort((a, b) => (a.examDate ?? '').localeCompare(b.examDate ?? '') || a.name.localeCompare(b.name) || (sectionOrder.get(a.sectionId) ?? 0) - (sectionOrder.get(b.sectionId) ?? 0));
    const markByKey = new Map(data.examMarks.map((m) => [`${m.examId}:${m.enrollmentId}`, m]));

    const rows: Array<Record<string, CellValue>> = [];
    for (const exam of exams) {
      for (const e of data.enrollments.filter((x) => x.sectionId === exam.sectionId)) {
        const m = markByKey.get(`${exam.examId}:${e.enrollmentId}`);
        rows.push({
          studentId: e.studentId,
          fullName: e.fullName,
          section: e.sectionLabel,
          exam: exam.name,
          term: TERM_LABELS[exam.term as Term],
          date: exam.examDate,
          marks: m ? m.marks : null,
          max: exam.maxMarks,
          percent: m ? percentOf(m.marks, exam.maxMarks) : null,
          state: STATE_LABEL[m ? m.status : 'missing'],
        });
      }
    }
    const wb = this.excel.createWorkbook();
    this.excel.addTable(wb, `${TERM_LABELS[term]} exams`, {
      title: `${TERM_LABELS[term]} examination marks`,
      subtitle: this.subtitle(year, scope, 'Percentages use each examination\'s own maximum. Blank = not entered.'),
      columns: [
        text('Student ID', 'studentId', 16),
        text('Student Name', 'fullName', 32),
        text('Section', 'section', 10),
        text('Examination', 'exam', 28),
        text('Term', 'term', 14),
        text('Date', 'date', 12),
        marks('Marks', 'marks', 10),
        marks('Maximum', 'max', 10),
        percent('Percentage (%)', 'percent'),
        text('Status', 'state', 12),
      ],
      rows,
      freezeColumns: 2,
    });
    return this.finish(wb, 'exam-marks', year.label, scope.fileLabel, `T${term}`, q.examId ? (exams[0]?.name ?? '') : '');
  }

  // ------------------------------------------------------------------------------------------------------
  // 4. one student's complete results
  // ------------------------------------------------------------------------------------------------------
  private async studentResult(auth: AuthContext, q: ExportQuery): Promise<ExportFile> {
    if (!q.enrollmentId) throw Errors.badRequest('Choose a student for this export.', undefined, 'STUDENT_REQUIRED');
    const p = await this.results.teacherProfile(auth, q.enrollmentId); // also enforces that the student is in the teacher's sections
    const wb = this.excel.createWorkbook();
    const flags = p.flags ? flagLabels(p.flags) : '';

    this.excel.addKeyValues(
      wb,
      'Summary',
      `${p.student.fullName} - results`,
      [
        ['Student ID', p.student.studentId],
        ['Student name', p.student.fullName],
        ['Class', p.className],
        ['Section', p.section.label],
        ['Academic year', `${p.academicYear.label} (${YEAR_STATUS_LABEL[p.academicYear.status]})`],
        ['Performance index (%)', p.overallIndex],
        ['Trend', TREND_LABEL[p.trend]],
        ['Change between last two terms (points)', p.trendDelta],
        ['Monitoring flags', flags || null],
        ['How the index is calculated', p.basis?.description ?? null],
      ],
      `Exported ${today()}`,
    );

    const componentRows: Array<Record<string, CellValue>> = [];
    const categoryRows: Array<Record<string, CellValue>> = [];
    for (const t of p.terms) {
      for (const c of t.components) {
        const counted = isCounted(c.state);
        componentRows.push({
          term: t.label,
          result: c.label,
          date: c.examDate,
          marks: counted ? c.marks : null, // a partial assessment has no total yet
          max: c.max,
          percent: c.percent,
          state: STATE_LABEL[c.state],
        });
        if (c.kind === 'assessment') {
          const row: Record<string, CellValue> = { term: t.label, total: counted ? c.marks : null, state: STATE_LABEL[c.state] };
          for (const cat of ASSESSMENT_CATEGORIES) row[cat.field] = c.scores ? c.scores[cat.field] : null;
          categoryRows.push(row);
        }
      }
    }
    this.excel.addTable(wb, 'Results', {
      title: 'Assessment and examination results',
      subtitle: `${p.student.fullName} (${p.student.studentId})  |  ${p.academicYear.label}  |  Blank = not entered`,
      columns: [text('Term', 'term', 14), text('Result', 'result', 32), text('Date', 'date', 12), marks('Marks', 'marks', 10), marks('Maximum', 'max', 10), percent('Percentage (%)', 'percent'), text('Status', 'state', 12)],
      rows: componentRows,
    });
    this.excel.addTable(wb, 'Assessment categories', {
      title: 'Continuous assessment by category',
      subtitle: `${p.student.fullName} (${p.student.studentId})  |  ${p.academicYear.label}`,
      columns: [text('Term', 'term', 14), ...ASSESSMENT_CATEGORIES.map((c) => marks(`${c.name} (/${c.maxMarks})`, c.field, 18)), marks(`Total (/${ASSESSMENT_MAX_TOTAL})`, 'total'), text('Status', 'state', 12)],
      rows: categoryRows,
    });
    this.excel.addTable(wb, 'Term averages', {
      title: 'Term averages',
      subtitle: 'Average of the complete results in each term. Terms without complete results are blank.',
      columns: [text('Term', 'term', 16), percent('Average (%)', 'index')],
      rows: p.terms.map((t) => ({ term: t.label, index: t.index })),
    });
    if (p.history.length) {
      this.excel.addTable(wb, 'Other academic years', {
        title: 'Other academic years',
        subtitle: `${p.student.fullName} (${p.student.studentId})`,
        columns: [text('Academic Year', 'year', 16), text('Section', 'section', 10), percent('Performance index (%)', 'index', 20), ...TERMS.map((t) => percent(`${TERM_LABELS[t]} average (%)`, `t${t}`, 20))],
        rows: p.history.map((h) => ({
          year: h.academicYearLabel,
          section: h.sectionLabel,
          index: h.overallIndex,
          t1: h.termIndexes.find((t) => t.term === 1)?.index ?? null,
          t2: h.termIndexes.find((t) => t.term === 2)?.index ?? null,
          t3: h.termIndexes.find((t) => t.term === 3)?.index ?? null,
        })),
      });
    }
    return this.finish(wb, 'student-result', p.student.studentId, p.academicYear.label);
  }

  // ------------------------------------------------------------------------------------------------------
  // 5. rankings
  // ------------------------------------------------------------------------------------------------------
  private async rankingsReport(auth: AuthContext, q: ExportQuery): Promise<ExportFile> {
    const year = await this.requireYear(q);
    if (!q.sectionId) throw Errors.badRequest('Choose a section for this export.', undefined, 'SECTION_REQUIRED');
    const kind = q.kind ?? 'index';
    if (kind === 'assessment' && !q.term) throw Errors.badRequest('Choose a term for an assessment ranking.', undefined, 'TERM_REQUIRED');
    if (kind === 'exam' && !q.examId) throw Errors.badRequest('Choose an examination for an examination ranking.', undefined, 'EXAM_REQUIRED');
    const scopeKind = q.scope ?? 'section';
    const ranking = await this.rankings.rank(auth, { academicYearId: year.id, sectionId: q.sectionId, scope: scopeKind, kind, term: q.term, examId: q.examId });
    const scope = await this.resolveScope(auth, { ...q, scope: scopeKind }, { sectionRequired: true });

    const wb = this.excel.createWorkbook();
    this.excel.addTable(wb, 'Ranking', {
      title: `Ranking - ${ranking.title}`,
      subtitle: `${this.subtitle(year, scope)}  |  ${ranking.context}`,
      columns: [int('Rank', 'rank', 8), text('Student ID', 'studentId', 16), text('Student Name', 'fullName', 32), text('Section', 'section', 10), marks('Marks', 'marks', 10), marks('Maximum', 'max', 10), percent('Percentage (%)', 'percent')],
      rows: ranking.items.map((i) => ({ rank: i.rank, studentId: i.studentId, fullName: i.fullName, section: i.sectionLabel, marks: i.marks, max: i.max, percent: i.percent })),
      freezeColumns: 3,
    });
    if (ranking.unranked.length) {
      this.excel.addTable(wb, 'Not ranked', {
        title: 'Students without a complete result',
        subtitle: 'These students are not ranked, and their missing results are not counted as zero.',
        columns: [text('Student ID', 'studentId', 16), text('Student Name', 'fullName', 32), text('Section', 'section', 10)],
        rows: ranking.unranked.map((u) => ({ studentId: u.studentId, fullName: u.fullName, section: u.sectionLabel })),
      });
    }
    return this.finish(wb, 'ranking', kind, year.label, scope.fileLabel, q.term ? `T${q.term}` : '');
  }

  // ------------------------------------------------------------------------------------------------------
  // 6. academic-year report
  // ------------------------------------------------------------------------------------------------------
  private async academicYearReport(auth: AuthContext, q: ExportQuery): Promise<ExportFile> {
    const year = await this.requireYear(q);
    const scope = await this.resolveScope(auth, q, { sectionRequired: false });
    const data = await this.results.loadScope(year.id, scope.ids);
    const all = computeStudentResults(data);
    const withIndex = all.filter((r) => r.overallIndex !== null);
    const indexes = withIndex.map((r) => r.overallIndex as number);
    const assessmentByKey = new Map(data.assessments.map((a) => [`${a.enrollmentId}:${a.term}`, a]));
    const wb = this.excel.createWorkbook();

    const overview: Array<[string, CellValue]> = [
      ['Academic year', year.label],
      ['Status', YEAR_STATUS_LABEL[year.status]],
      ['Sections included', scope.sections.map((s) => s.label).join(', ') || null],
      ['Students enrolled', all.length],
      ['Students with at least one complete result', withIndex.length],
      ['Students without any complete result', all.length - withIndex.length],
      ['Average performance index (%)', mean(indexes)],
      ['Highest performance index (%)', indexes.length ? Math.max(...indexes) : null],
      ['Lowest performance index (%)', indexes.length ? Math.min(...indexes) : null],
      ['Examinations created', data.exams.length],
    ];
    for (const term of TERMS) {
      const states = data.assessments.filter((a) => a.term === term).map((a) => assessmentState(a.scores, a.status === 'finalized'));
      overview.push([`${TERM_LABELS[term]} assessments complete`, `${states.filter(isCounted).length} of ${all.length}`]);
      overview.push([`${TERM_LABELS[term]} assessments finalized`, states.filter((s) => s === 'finalized').length]);
    }
    overview.push(['Note', 'The performance index is for monitoring only and is not a final grade. Missing results are never counted as zero.']);
    this.excel.addKeyValues(wb, 'Overview', `Academic year report - ${year.label}`, overview, this.subtitle(null, scope));

    this.excel.addTable(wb, 'Sections', {
      title: 'Sections',
      subtitle: this.subtitle(year, scope),
      columns: [text('Section', 'section', 10), int('Students', 'students'), int('With results', 'withResults', 14), percent('Average index (%)', 'avg', 18), percent('Highest (%)', 'high'), percent('Lowest (%)', 'low')],
      rows: scope.sections.map((s) => {
        const mine = all.filter((r) => r.sectionId === s.id);
        const idx = mine.map((r) => r.overallIndex).filter((v): v is number => v !== null);
        const sum = summarize(idx);
        return { section: s.label, students: mine.length, withResults: idx.length, avg: sum.average, high: sum.highest, low: sum.lowest };
      }),
    });

    this.excel.addTable(wb, 'Student results', {
      title: 'Student results',
      subtitle: this.subtitle(year, scope, 'Averages use only complete results. Blank = no complete result.'),
      columns: [
        text('Student ID', 'studentId', 16),
        text('Student Name', 'fullName', 32),
        text('Section', 'section', 10),
        ...TERMS.map((t) => marks(`${TERM_LABELS[t]} assessment (/${ASSESSMENT_MAX_TOTAL})`, `a${t}`, 20)),
        ...TERMS.map((t) => percent(`${TERM_LABELS[t]} average (%)`, `i${t}`, 18)),
        percent('Performance index (%)', 'index', 20),
        text('Trend', 'trend', 16),
        text('Monitoring flags', 'flags', 30),
      ],
      rows: all.map((r) => {
        const row: Record<string, CellValue> = { studentId: r.studentId, fullName: r.fullName, section: r.sectionLabel, index: r.overallIndex, trend: TREND_LABEL[r.trend], flags: flagLabels(r.flags) };
        for (const t of TERMS) {
          const a = assessmentByKey.get(`${r.enrollmentId}:${t}`);
          const counted = a && isCounted(assessmentState(a.scores, a.status === 'finalized'));
          row[`a${t}`] = a && counted ? assessmentTotal(a.scores) : null;
          row[`i${t}`] = r.terms.find((x) => x.term === t)!.index;
        }
        return row;
      }),
      freezeColumns: 2,
    });

    this.excel.addTable(wb, 'Examinations', { title: 'Examinations', subtitle: this.subtitle(year, scope), ...this.examinationTable(data, scope) });
    return this.finish(wb, 'academic-year-report', year.label, scope.fileLabel);
  }

  /** One row per examination with its completion and statistics. Missing marks reduce "Entered", never the average. */
  private examinationTable(data: ScopeData, scope: ResolvedScope): { columns: ColumnDef[]; rows: Array<Record<string, CellValue>> } {
    const sectionLabel = new Map(scope.sections.map((s) => [s.id, s.label]));
    const enrolled = new Map<string, number>();
    for (const e of data.enrollments) enrolled.set(e.sectionId, (enrolled.get(e.sectionId) ?? 0) + 1);
    const rows = data.exams
      .slice()
      .sort((a, b) => a.term - b.term || (a.examDate ?? '').localeCompare(b.examDate ?? '') || a.name.localeCompare(b.name) || (sectionLabel.get(a.sectionId) ?? '').localeCompare(sectionLabel.get(b.sectionId) ?? ''))
      .map((x) => {
        const m = data.examMarks.filter((k) => k.examId === x.examId).map((k) => k.marks);
        const sum = summarize(m);
        const total = enrolled.get(x.sectionId) ?? 0;
        return {
          exam: x.name,
          term: TERM_LABELS[x.term as Term],
          section: sectionLabel.get(x.sectionId) ?? '',
          date: x.examDate,
          max: x.maxMarks,
          students: total,
          entered: m.length,
          missing: total - m.length,
          avg: sum.average,
          avgPercent: sum.average === null ? null : percentOf(sum.average, x.maxMarks),
          high: sum.highest,
          low: sum.lowest,
        };
      });
    return {
      columns: [
        text('Examination', 'exam', 28),
        text('Term', 'term', 14),
        text('Section', 'section', 10),
        text('Date', 'date', 12),
        marks('Maximum', 'max', 10),
        int('Students', 'students'),
        int('Entered', 'entered'),
        int('Missing', 'missing'),
        marks('Average', 'avg', 10),
        percent('Average (%)', 'avgPercent'),
        marks('Highest', 'high', 10),
        marks('Lowest', 'low', 10),
      ],
      rows,
    };
  }

  // ------------------------------------------------------------------------------------------------------
  // 7. class / section performance (the same numbers as the Analytics screen)
  // ------------------------------------------------------------------------------------------------------
  private async classPerformance(auth: AuthContext, q: ExportQuery): Promise<ExportFile> {
    const year = await this.requireYear(q);
    if (!q.sectionId) throw Errors.badRequest('Choose a section for this export.', undefined, 'SECTION_REQUIRED');
    const a = await this.analytics.section(auth, year.id, q.sectionId); // enforces the teacher's section assignment
    const wb = this.excel.createWorkbook();
    const sub = `Academic year ${year.label}  |  Section ${a.section.label}  |  Exported ${today()}`;
    const person = (p: { studentId: string; fullName: string; sectionLabel: string; index: number | null; trend: Trend; trendDelta: number | null }) => ({
      studentId: p.studentId,
      fullName: p.fullName,
      section: p.sectionLabel,
      index: p.index,
      trend: TREND_LABEL[p.trend],
      delta: p.trendDelta,
    });

    this.excel.addKeyValues(
      wb,
      'Summary',
      `Class performance - Section ${a.section.label}`,
      [
        ['Academic year', year.label],
        ['Students in section', a.totals.students],
        ['Students with a result', a.totals.withResults],
        ['Students without any complete result', a.totals.withoutResults],
        ['Section average index (%)', a.sectionAverage.average],
        ['Section highest index (%)', a.sectionAverage.highest],
        ['Section lowest index (%)', a.sectionAverage.lowest],
        [`Class average index (%) - sections ${a.classAverage.sections.join(', ')}`, a.classAverage.average],
        ['Highest student', a.highestStudent ? `${a.highestStudent.fullName} (${a.highestStudent.studentId})` : null],
        ['Lowest student', a.lowestStudent ? `${a.lowestStudent.fullName} (${a.lowestStudent.studentId})` : null],
        ['Note', 'The performance index is for monitoring only and is not a final grade. Missing results are never counted as zero.'],
      ],
      sub,
    );
    const personColumns = [text('Student ID', 'studentId', 16), text('Student Name', 'fullName', 32), text('Section', 'section', 10), percent('Performance index (%)', 'index', 20), text('Trend', 'trend', 16), marks('Change (points)', 'delta', 16)];
    this.excel.addTable(wb, 'Ranking', {
      title: 'Ranking by performance index',
      subtitle: sub,
      columns: [int('Rank', 'rank', 8), ...personColumns],
      rows: a.ranking.map((r) => ({ rank: r.rank, ...person(r) })),
      freezeColumns: 3,
    });
    if (a.unranked.length) {
      this.excel.addTable(wb, 'Not ranked', { title: 'Students without a complete result', subtitle: 'Not ranked; never counted as zero.', columns: [text('Student ID', 'studentId', 16), text('Student Name', 'fullName', 32), text('Section', 'section', 10)], rows: a.unranked.map(person) });
    }
    this.excel.addTable(wb, 'Assessments', {
      title: 'Continuous assessment performance',
      subtitle: sub,
      columns: [
        text('Term', 'term', 14),
        int('Students', 'enrolled'),
        int('Complete', 'entered'),
        int('Finalized', 'finalized'),
        int('Missing', 'missing'),
        marks(`Average (/${ASSESSMENT_MAX_TOTAL})`, 'avg', 14),
        marks('Highest', 'high', 10),
        marks('Lowest', 'low', 10),
        percent('Average (%)', 'avgPercent'),
        ...ASSESSMENT_CATEGORIES.map((c) => marks(`${c.name} avg (/${c.maxMarks})`, c.field, 20)),
      ],
      rows: a.assessmentPerformance.map((t) => {
        const row: Record<string, CellValue> = { term: t.label, enrolled: t.enrolled, entered: t.entered, finalized: t.finalized, missing: t.missing, avg: t.averageTotal, high: t.highestTotal, low: t.lowestTotal, avgPercent: t.averagePercent };
        for (const c of t.categories) {
          const cat = ASSESSMENT_CATEGORIES.find((x) => x.code === c.code)!;
          row[cat.field] = c.average;
        }
        return row;
      }),
    });
    this.excel.addTable(wb, 'Examinations', {
      title: 'Examination performance',
      subtitle: sub,
      columns: [text('Examination', 'exam', 28), text('Term', 'term', 14), text('Date', 'date', 12), marks('Maximum', 'max', 10), int('Students', 'students'), int('Entered', 'entered'), int('Missing', 'missing'), marks('Average', 'avg', 10), percent('Average (%)', 'avgPercent'), marks('Highest', 'high', 10), marks('Lowest', 'low', 10)],
      rows: a.examPerformance.map((x) => ({ exam: x.name, term: x.termLabel, date: x.examDate, max: x.maxMarks, students: x.enrolled, entered: x.entered, missing: x.missing, avg: x.average, avgPercent: x.averagePercent, high: x.highest, low: x.lowest })),
    });
    this.excel.addTable(wb, 'Distribution', { title: 'Performance index distribution', subtitle: sub, columns: [text('Range (%)', 'label', 14), int('Students', 'count')], rows: a.distribution.map((d) => ({ label: d.label, count: d.count })) });

    const attention: Array<Record<string, CellValue>> = [];
    const groups: Array<[string, typeof a.attention.exceptional]> = [
      ['Performing exceptionally well', a.attention.exceptional],
      ['Low academic performance', a.attention.low],
      ['Requires additional support', a.attention.needsSupport],
      ['Improving', a.attention.improving],
      ['Declining', a.attention.declining],
    ];
    for (const [category, list] of groups) for (const p of list) attention.push({ category, ...person(p) });
    this.excel.addTable(wb, 'Monitoring', {
      title: 'Students to recognise or support',
      subtitle: `${sub}  |  A student can appear in more than one group.`,
      columns: [text('Group', 'category', 30), ...personColumns],
      rows: attention,
    });
    if (a.sectionAverages.length > 1) {
      this.excel.addTable(wb, 'Sections compared', {
        title: 'Sections of this class compared',
        subtitle: sub,
        columns: [text('Section', 'label', 10), int('Students with results', 'students', 20), percent('Average index (%)', 'average', 18)],
        rows: a.sectionAverages.map((s) => ({ label: s.label, students: s.students, average: s.average })),
      });
    }
    return this.finish(wb, 'class-performance', year.label, a.section.label);
  }
}
