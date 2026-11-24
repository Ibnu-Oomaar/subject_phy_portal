
import { getAssessmentMaxTotal } from '../assessments/assessment-categories';
import type { ResultState, Term } from '../common/types';
import { TERMS, TERM_LABELS } from '../common/types';
import {
  assessmentPercent,
  assessmentState,
  assessmentTotal,
  classify,
  isCounted,
  mean,
  percentOf,
  trendOf,
  type AssessmentScores,
  type PerformanceFlags,
  type Trend,
} from './calculations';
import { RESULTS_CONFIG } from './results.config';

// ---- plain input rows (loaded by ResultsService, built by hand in unit tests) ------------------------------------
export interface EnrollmentRow {
  enrollmentId: string;
  studentUuid: string;
  studentId: string;
  fullName: string;
  sectionId: string;
  sectionLabel: string;
  classId: number;
}
export interface AssessmentRow {
  enrollmentId: string;
  term: number;
  scores: AssessmentScores;
  status: 'entered' | 'finalized';
}
export interface ExamRow {
  examId: string;
  sectionId: string;
  term: number;
  name: string;
  maxMarks: number;
  examDate: string | null;
}
export interface ExamMarkRow {
  examId: string;
  enrollmentId: string;
  marks: number;
  status: 'entered' | 'finalized';
}
export interface ScopeData {
  enrollments: EnrollmentRow[];
  assessments: AssessmentRow[];
  exams: ExamRow[];
  examMarks: ExamMarkRow[];
}

// ---- output ------------------------------------------------------------------------------------------------------
export interface ResultComponent {
  kind: 'assessment' | 'exam';
  term: Term;
  label: string;
  examId: string | null;
  examDate: string | null;
  /** assessment: sum of entered categories (provisional while partial) · exam: the mark · null when missing */
  marks: number | null;
  max: number;
  /** only for entered/finalized results */
  percent: number | null;
  state: ResultState;
  scores: AssessmentScores | null;
}

export interface TermResult {
  term: Term;
  label: string;
  components: ResultComponent[];
  /** mean percentage of this term's counted components (null when none counted) */
  index: number | null;
}

export interface StudentResult {
  enrollmentId: string;
  studentUuid: string;
  studentId: string;
  fullName: string;
  sectionId: string;
  sectionLabel: string;
  terms: TermResult[];
  /** monitoring index: mean of term indexes (see results.config.ts) - NOT a final grade */
  overallIndex: number | null;
  trend: Trend;
  trendDelta: number | null;
  flags: PerformanceFlags;
}

const isTerm = (n: number): n is Term => n === 1 || n === 2 || n === 3;

/** The default (and currently only) aggregation: every term counts equally, missing results are skipped. */
function meanOfTermMeans(terms: TermResult[]): number | null {
  return mean(terms.map((t) => t.index).filter((v): v is number => v !== null));
}

export function computeStudentResults(data: ScopeData): StudentResult[] {
  const assessmentsByKey = new Map(data.assessments.map((a) => [`${a.enrollmentId}:${a.term}`, a]));
  const marksByKey = new Map(data.examMarks.map((m) => [`${m.examId}:${m.enrollmentId}`, m]));

  return data.enrollments.map((enrollment) => {
    const classId = enrollment.classId;
    const assessmentMaxTotal = getAssessmentMaxTotal(classId);

    const terms: TermResult[] = TERMS.map((term) => {
      const components: ResultComponent[] = [];

      const assessment = assessmentsByKey.get(`${enrollment.enrollmentId}:${term}`);
      if (assessment) {
        const total = assessmentTotal(assessment.scores, classId);
        const state = assessmentState(assessment.scores, assessment.status === 'finalized', classId);
        components.push({
          kind: 'assessment',
          term,
          label: `${TERM_LABELS[term]} assessment`,
          examId: null,
          examDate: null,
          marks: total,
          max: assessmentMaxTotal,
          percent: isCounted(state) && total !== null ? assessmentPercent(total, classId) : null,
          state,
          scores: assessment.scores,
        });
      } else {
        components.push({
          kind: 'assessment',
          term,
          label: `${TERM_LABELS[term]} assessment`,
          examId: null,
          examDate: null,
          marks: null,
          max: assessmentMaxTotal,
          percent: null,
          state: 'missing',
          scores: null,
        });
      }

      const exams = data.exams
        .filter((e) => e.sectionId === enrollment.sectionId && e.term === term)
        .sort((a, b) => (a.examDate ?? '').localeCompare(b.examDate ?? '') || a.name.localeCompare(b.name));

      for (const exam of exams) {
        const mark = marksByKey.get(`${exam.examId}:${enrollment.enrollmentId}`);
        components.push({
          kind: 'exam',
          term,
          label: exam.name,
          examId: exam.examId,
          examDate: exam.examDate,
          marks: mark ? mark.marks : null,
          max: exam.maxMarks,
          percent: mark ? percentOf(mark.marks, exam.maxMarks) : null,
          state: mark ? mark.status : 'missing',
          scores: null,
        });
      }

      const counted = components.filter((c) => isCounted(c.state) && c.percent !== null).map((c) => c.percent as number);
      return { term, label: TERM_LABELS[term], components, index: mean(counted) };
    });

    const overallIndex = meanOfTermMeans(terms);
    const { trend, delta } = trendOf(terms.map((t) => ({ term: t.term, index: t.index })), RESULTS_CONFIG.thresholds.trendBand);

    return {
      enrollmentId: enrollment.enrollmentId,
      studentUuid: enrollment.studentUuid,
      studentId: enrollment.studentId,
      fullName: enrollment.fullName,
      sectionId: enrollment.sectionId,
      sectionLabel: enrollment.sectionLabel,
      terms,
      overallIndex,
      trend,
      trendDelta: delta,
      flags: classify(overallIndex, trend),
    };
  });
}

export { isTerm };
