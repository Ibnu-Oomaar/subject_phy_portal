
import { ASSESSMENT_CATEGORIES_BY_CLASS, getAssessmentFields, getAssessmentMaxTotal, type AssessmentField } from '../assessments/assessment-categories';
import { fromHundredths, round2, toHundredths } from '../common/decimal';
import type { ResultState } from '../common/types';
import { RESULTS_CONFIG, type PerformanceThresholds } from './results.config';

/**
 * Pure calculation helpers. All money-style arithmetic is done in hundredths so 0.1 + 0.2 style float drift can
 * never leak into a total, an average or a ranking.
 */

export type AssessmentScores = Record<AssessmentField, number | null>;

const ALL_ASSESSMENT_FIELDS = [
  ...new Set(
    Object.values(ASSESSMENT_CATEGORIES_BY_CLASS).flatMap((categories) =>
      categories.map((category) => category.field),
    ),
  ),
] as AssessmentField[];

export const emptyScores = (_classId: number): AssessmentScores =>
  Object.fromEntries(ALL_ASSESSMENT_FIELDS.map((f) => [f, null])) as AssessmentScores;

/** Sum of the categories that have been entered, or null when none has (never 0 for "nothing entered"). */
export function assessmentTotal(scores: AssessmentScores, classId: number): number | null {
  const fields = getAssessmentFields(classId);
  const entered = fields.map((f) => scores[f]).filter((v): v is number => v !== null);
  if (!entered.length) return null;
  return fromHundredths(entered.reduce((sum, v) => sum + toHundredths(v), 0));
}

export function assessmentState(scores: AssessmentScores, finalized: boolean, classId: number): ResultState {
  const fields = getAssessmentFields(classId);
  const filled = fields.filter((f) => scores[f] !== null).length;
  if (filled === 0) return 'missing';
  if (filled < fields.length) return 'partial';
  return finalized ? 'finalized' : 'entered';
}

/** Only complete (entered/finalized) results take part in averages, rankings and analytics. */
export const isCounted = (state: ResultState): boolean => state === 'entered' || state === 'finalized';

export function percentOf(marks: number, max: number): number {
  return round2((toHundredths(marks) * 100) / toHundredths(max));
}

export const assessmentPercent = (total: number, classId: number): number =>
  percentOf(total, getAssessmentMaxTotal(classId));

export function mean(values: number[]): number | null {
  if (!values.length) return null;
  const sum = values.reduce((s, v) => s + toHundredths(v), 0);
  return round2(sum / 100 / values.length);
}

export interface Summary {
  count: number;
  average: number | null;
  highest: number | null;
  lowest: number | null;
}

export function summarize(values: number[]): Summary {
  if (!values.length) return { count: 0, average: null, highest: null, lowest: null };
  return { count: values.length, average: mean(values), highest: Math.max(...values), lowest: Math.min(...values) };
}

export interface Ranked<T> {
  item: T;
  rank: number;
}

/**
 * Standard competition ranking (1, 2, 2, 4): equal values share a rank and the next rank is skipped.
 * Highest value ranks first. Callers pass only the items that have a value; unranked items stay unranked.
 */
export function rankDescending<T>(
  items: T[],
  value: (item: T) => number,
  /** Only orders students who share a rank (so output is stable); it never changes a rank. */
  tieBreak?: (a: T, b: T) => number,
): Array<Ranked<T>> {
  const sorted = [...items].sort((a, b) => toHundredths(value(b)) - toHundredths(value(a)) || (tieBreak ? tieBreak(a, b) : 0));
  const out: Array<Ranked<T>> = [];
  sorted.forEach((item, i) => {
    const prev = out[i - 1];
    const tied = prev && toHundredths(value(prev.item)) === toHundredths(value(item));
    out.push({ item, rank: tied ? prev.rank : i + 1 });
  });
  return out;
}

export type Trend = 'improving' | 'declining' | 'steady' | 'insufficient';

/** Compares the last two terms that have an index. Needs at least two such terms. */
export function trendOf(
  termIndexes: Array<{ term: number; index: number | null }>,
  band: number = RESULTS_CONFIG.thresholds.trendBand,
): { trend: Trend; delta: number | null } {
  const withIndex = termIndexes
    .filter((t): t is { term: number; index: number } => t.index !== null)
    .sort((a, b) => a.term - b.term);
  if (withIndex.length < 2) return { trend: 'insufficient', delta: null };
  const delta = round2(withIndex[withIndex.length - 1]!.index - withIndex[withIndex.length - 2]!.index);
  if (delta >= band) return { trend: 'improving', delta };
  if (delta <= -band) return { trend: 'declining', delta };
  return { trend: 'steady', delta };
}

export interface PerformanceFlags {
  exceptional: boolean;
  low: boolean;
  needsSupport: boolean;
  improving: boolean;
  declining: boolean;
}

export function classify(
  index: number | null,
  trend: Trend,
  t: PerformanceThresholds = RESULTS_CONFIG.thresholds,
): PerformanceFlags {
  if (index === null) return { exceptional: false, low: false, needsSupport: false, improving: false, declining: false };
  return {
    exceptional: index >= t.exceptionalMin,
    low: index < t.lowBelow,
    needsSupport: index < t.supportBelow || (trend === 'declining' && index < t.decliningSupportBelow),
    improving: trend === 'improving',
    declining: trend === 'declining',
  };
}

/** Alphabetical order for students who share a rank. */
export const byName = (a: { fullName: string; studentId: string }, b: { fullName: string; studentId: string }): number =>
  a.fullName.localeCompare(b.fullName) || a.studentId.localeCompare(b.studentId);

/** Histogram buckets for the score distribution chart. */
export const DISTRIBUTION_BUCKETS = [
  { label: '0-39', min: 0, max: 39.99 },
  { label: '40-49', min: 40, max: 49.99 },
  { label: '50-59', min: 50, max: 59.99 },
  { label: '60-69', min: 60, max: 69.99 },
  { label: '70-79', min: 70, max: 79.99 },
  { label: '80-89', min: 80, max: 89.99 },
  { label: '90-100', min: 90, max: 100 },
] as const;

export function distribution(values: number[]): Array<{ label: string; count: number }> {
  return DISTRIBUTION_BUCKETS.map((b) => ({ label: b.label, count: values.filter((v) => v >= b.min && v <= b.max).length }));
}
