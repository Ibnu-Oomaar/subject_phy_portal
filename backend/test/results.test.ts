import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client, startApp, type TestApp } from './helpers';

let t: TestApp;
let teacher: Client;
let other: Client; // only assigned to 1C
const S: Record<string, string> = {};
const E: Record<string, string> = {};
const X: Record<string, string> = {}; // exam ids
let year = '';

const saveAssessment = (key: string, term: number, values: Record<string, number>, section = 'B') =>
  teacher.put('/assessments/marks', { academicYearId: year, sectionId: S[section], term, entries: [{ enrollmentId: E[key], version: 0, ...values }] });
const saveMark = (examId: string, key: string, marks: number | null, version = 0) =>
  teacher.put(`/examinations/${examId}/marks`, { entries: [{ enrollmentId: E[key], version, marks }] });
const a = (ca: number, hw: number, lm: number, tb: number) => ({ classActivities: ca, homeworkAssignments: hw, learningMaterialsNotebook: lm, textbook: tb });

beforeAll(async () => {
  t = await startApp();
  await t.teachers.create({ name: 'Ms Test' });
  await t.teachers.create({ name: 'Mr Other', sectionLabels: ['1C'] });
  teacher = t.client();
  other = t.client();
  await teacher.loginTeacher('Ms Test');
  await other.loginTeacher('Mr Other');
  for (const sec of (await teacher.get('/classes')).body[0].sections) S[sec.code] = sec.id;
});

afterAll(async () => {
  await t.close();
});

describe('dashboard before any data exists', () => {
  test('returns an honest empty state, not fake numbers', async () => {
    const r = await teacher.get('/analytics/dashboard');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ academicYear: null, empty: true, totals: { students: 0, sections: 7 } });
  });
});

describe('fixture', () => {
  test('creates a year, students, exams and marks', async () => {
    year = (await teacher.post('/academic-years', { label: '2026/2027' })).body.id;
    const enroll = async (key: string, section: string, id: string, name: string) => {
      E[key] = (await teacher.post('/students', { academicYearId: year, sectionId: S[section], studentId: id, fullName: name })).body.enrollmentId;
    };
    await enroll('amina', 'B', 'T-1001', 'Amina Ali');
    await enroll('brian', 'B', 'T-1002', 'Brian Otieno');
    await enroll('cynthia', 'B', 'T-1003', 'Cynthia Mwangi');
    await enroll('dan', 'B', 'T-1004', 'Dan Njoroge');
    await enroll('carl', 'C', 'T-2001', 'Carl Kamau');

    const t1 = (await teacher.post('/examinations', { academicYearId: year, sectionIds: [S.B, S.C], term: 1, name: 'Term 1 Physics Examination', maxMarks: 50 })).body;
    X.t1B = t1.find((x: any) => x.sectionLabel === '1B').id;
    X.t1C = t1.find((x: any) => x.sectionLabel === '1C').id;
    // section C sits the same exam out of 100: percentages must use each exam's own maximum
    expect((await teacher.patch(`/examinations/${X.t1C}`, { maxMarks: 100 })).status).toBe(200);
    X.t2B = (await teacher.post('/examinations', { academicYearId: year, sectionId: S.B, term: 2, name: 'Term 2 Physics Examination', maxMarks: 60 })).body[0].id;

    // amina: T1 assessment 30/30=100, T1 exam 45/50=90 (T1 index 95); T2 exam 54/60=90 (T2 index 90)
    expect((await saveAssessment('amina', 1, a(9, 6, 10, 5))).status).toBe(200);
    expect((await saveMark(X.t1B!, 'amina', 45)).status).toBe(200);
    expect((await saveMark(X.t2B!, 'amina', 54)).status).toBe(200);
    // brian: T1 assessment 15/30=50, T1 exam 20/50=40 (T1 index 45); T2 exam 42/60=70 (T2 index 70)
    expect((await saveAssessment('brian', 1, a(5, 3, 5, 2))).status).toBe(200);
    expect((await saveMark(X.t1B!, 'brian', 20)).status).toBe(200);
    expect((await saveMark(X.t2B!, 'brian', 42)).status).toBe(200);
    // cynthia: T1 assessment 6/30=20, T1 exam 10/50=20 (index 20)
    expect((await saveAssessment('cynthia', 1, a(3, 1, 2, 0))).status).toBe(200);
    expect((await saveMark(X.t1B!, 'cynthia', 10)).status).toBe(200);
    // dan: only a PARTIAL assessment, no exam marks -> must not be ranked or flagged
    expect((await saveAssessment('dan', 1, { classActivities: 4 })).status).toBe(200);
    // carl (1C): T1 exam 90/100 = 90 -> index 90
    expect((await saveMark(X.t1C!, 'carl', 90)).status).toBe(200);
  });
});

describe('individual student profile (teacher view)', () => {
  test('amina: assessment and exam kept separate, each against its own maximum', async () => {
    const p = (await teacher.get(`/students/${E.amina}/profile`)).body;
    expect(p).toMatchObject({ student: { studentId: 'T-1001', fullName: 'Amina Ali' }, academicYear: { label: '2026/2027' }, section: { label: '1B' }, className: 'Class 1' });
    const t1 = p.terms[0];
    expect(t1.components.map((c: any) => [c.kind, c.label, c.marks, c.max, c.percent, c.state])).toEqual([
      ['assessment', 'Term 1 assessment', 30, 30, 100, 'entered'],
      ['exam', 'Term 1 Physics Examination', 45, 50, 90, 'entered'],
    ]);
    expect(p.terms[1].components[0]).toMatchObject({ kind: 'assessment', state: 'missing', marks: null, percent: null }); // missing, not zero
    expect(p.terms[1].components[1]).toMatchObject({ marks: 54, max: 60, percent: 90 });
    expect(p.terms.map((x: any) => x.index)).toEqual([95, 90, null]);
    expect(p.overallIndex).toBe(92.5);
    expect(p.trend).toBe('declining');
    expect(p.flags).toMatchObject({ exceptional: true, declining: true, needsSupport: false });
    expect(p.progress.map((x: any) => x.index)).toEqual([95, 90, null]);
    expect(p.basis.description).toContain('not a final grade');
  });
  test('dan has a partial assessment and nothing else: no index, no flags', async () => {
    const p = (await teacher.get(`/students/${E.dan}/profile`)).body;
    expect(p.terms[0].components[0]).toMatchObject({ state: 'partial', marks: 4, percent: null });
    expect(p.overallIndex).toBeNull();
    expect(p.flags).toMatchObject({ low: false, needsSupport: false, exceptional: false });
  });
  test('history across academic years is kept and visible', async () => {
    // enrol the same student in a later year in another section
    const y2 = (await teacher.post('/academic-years', { label: '2027/2028' })).body.id;
    const r = await teacher.post('/students', { academicYearId: y2, sectionId: S.D, studentId: 't-1001', fullName: 'Amina Ali' });
    expect(r.status).toBe(201);
    const p = (await teacher.get(`/students/${r.body.enrollmentId}/profile`)).body;
    expect(p.academicYear.label).toBe('2027/2028');
    expect(p.history).toHaveLength(1);
    expect(p.history[0]).toMatchObject({ academicYearLabel: '2026/2027', sectionLabel: '1B', overallIndex: 92.5 });
    // and the old year's profile still shows the same numbers
    expect((await teacher.get(`/students/${E.amina}/profile`)).body.overallIndex).toBe(92.5);
  });
});

describe('class and section analytics', () => {
  let s: any;
  test('loads real aggregates', async () => {
    const r = await teacher.get(`/analytics/section?academicYearId=${year}&sectionId=${S.B}`);
    expect(r.status).toBe(200);
    s = r.body;
    expect(s.totals).toEqual({ students: 4, withResults: 3, withoutResults: 1 });
  });
  test('section and class averages use only students that have results', async () => {
    expect(s.sectionAverage).toMatchObject({ average: 56.67, highest: 92.5, lowest: 20, students: 3 });
    expect(s.classAverage).toMatchObject({ average: 65, students: 4, sections: ['1B', '1C'] });
    expect(s.sectionAverages.map((x: any) => [x.label, x.average])).toEqual([['1B', 56.67], ['1C', 90]]);
  });
  test('highest, lowest and ranking (no result is never ranked last as zero)', async () => {
    expect(s.highestStudent).toMatchObject({ fullName: 'Amina Ali', index: 92.5 });
    expect(s.lowestStudent).toMatchObject({ fullName: 'Cynthia Mwangi', index: 20 });
    expect(s.ranking.map((r: any) => [r.rank, r.fullName])).toEqual([[1, 'Amina Ali'], [2, 'Brian Otieno'], [3, 'Cynthia Mwangi']]);
    expect(s.unranked.map((r: any) => r.fullName)).toEqual(['Dan Njoroge']);
  });
  test('assessment and examination performance', async () => {
    const t1 = s.assessmentPerformance[0];
    expect(t1).toMatchObject({ term: 1, enrolled: 4, entered: 3, missing: 1, averageTotal: 17, highestTotal: 30, lowestTotal: 6, averagePercent: 56.67 });
    expect(t1.categories.map((c: any) => [c.maxMarks, c.average])).toEqual([[9, 5.67], [6, 3.33], [10, 5.67], [5, 2.33]]);
    expect(s.assessmentPerformance[1]).toMatchObject({ term: 2, entered: 0, averageTotal: null }); // nothing entered -> null, not 0
    const e1 = s.examPerformance.find((x: any) => x.examId === X.t1B);
    expect(e1).toMatchObject({ maxMarks: 50, entered: 3, missing: 1, average: 25, averagePercent: 50, highest: 45, lowest: 10 });
    const e2 = s.examPerformance.find((x: any) => x.examId === X.t2B);
    expect(e2).toMatchObject({ maxMarks: 60, entered: 2, average: 48, averagePercent: 80, highest: 54, lowest: 42 });
  });
  test('term averages, distribution and performance groups', async () => {
    expect(s.termAverages.map((x: any) => [x.term, x.average, x.students])).toEqual([[1, 53.33, 3], [2, 80, 2], [3, null, 0]]);
    expect(Object.fromEntries(s.distribution.map((b: any) => [b.label, b.count]))).toMatchObject({ '0-39': 1, '50-59': 1, '90-100': 1, '60-69': 0 });
    const names = (g: any[]) => g.map((x) => x.fullName);
    expect(names(s.attention.exceptional)).toEqual(['Amina Ali']);
    expect(names(s.attention.low)).toEqual(['Cynthia Mwangi']);
    expect(names(s.attention.needsSupport)).toEqual(['Cynthia Mwangi']);
    expect(names(s.attention.improving)).toEqual(['Brian Otieno']);
    expect(names(s.attention.declining)).toEqual(['Amina Ali']);
  });
  test('results update immediately after a change (cache is invalidated)', async () => {
    const before = (await teacher.get(`/analytics/section?academicYearId=${year}&sectionId=${S.B}`)).body;
    expect(before.termAverages[1].average).toBe(80);
    const v = (await teacher.get(`/examinations/${X.t2B}/sheet`)).body.rows.find((r: any) => r.enrollmentId === E.brian).version;
    expect((await saveMark(X.t2B!, 'brian', 60, v)).status).toBe(200); // 60/60 = 100 -> T2 mean (90+100)/2
    const after = (await teacher.get(`/analytics/section?academicYearId=${year}&sectionId=${S.B}`)).body;
    expect(after.termAverages[1].average).toBe(95);
    await saveMark(X.t2B!, 'brian', 42, v + 1); // restore for the tests below
  });
});

describe('teacher dashboard (all from the database)', () => {
  test('totals, completion, sections, top students, attention', async () => {
    const d = (await teacher.get('/analytics/dashboard')).body;
    expect(d.academicYear).toMatchObject({ label: '2026/2027', status: 'active' });
    expect(d.totals).toEqual({ students: 5, sections: 7, sectionsWithStudents: 2 });
    // 5 students x 3 terms = 15 expected assessments; entered (complete) = amina, brian, cynthia in T1 only
    expect(d.assessmentCompletion).toMatchObject({ expected: 15, entered: 3, percent: 20 });
    expect(d.assessmentCompletion.byTerm[0]).toMatchObject({ term: 1, expected: 5, entered: 3, percent: 60 });
    // exams: T1B(4 students) + T1C(1) + T2B(4) = 9 expected; entered 3 + 1 + 2 = 6
    expect(d.examCompletion).toMatchObject({ examinations: 3, expected: 9, entered: 6 });
    expect(d.sections.find((x: any) => x.label === '1B')).toMatchObject({ students: 4, averageIndex: 56.67, examinations: 2 });
    expect(d.sections.find((x: any) => x.label === '1H')).toMatchObject({ students: 0, averageIndex: null });
    expect(d.topStudents.map((x: any) => [x.rank, x.fullName])).toEqual([[1, 'Amina Ali'], [2, 'Carl Kamau'], [3, 'Brian Otieno'], [4, 'Cynthia Mwangi']]);
    expect(d.attention.map((x: any) => x.fullName)).toEqual(['Cynthia Mwangi']);
    expect(d.counts).toMatchObject({ exceptional: 2, low: 1, needsSupport: 1, improving: 1, declining: 1 });
    expect(d.recentActivity.length).toBeGreaterThan(0);
    expect(d.recentActivity[0]).toMatchObject({ actorName: 'Ms Test' });
  });
  test('a teacher only sees their own sections in the dashboard', async () => {
    const d = (await other.get('/analytics/dashboard')).body;
    expect(d.totals).toEqual({ students: 1, sections: 1, sectionsWithStudents: 1 });
    expect(d.topStudents.map((x: any) => x.fullName)).toEqual(['Carl Kamau']);
  });
});

describe('rankings', () => {
  const rank = (q: string) => teacher.get(`/rankings?academicYearId=${year}&${q}`);
  test('performance index, section scope', async () => {
    const r = (await rank(`sectionId=${S.B}&kind=index`)).body;
    expect(r.items.map((x: any) => [x.rank, x.fullName, x.percent])).toEqual([[1, 'Amina Ali', 92.5], [2, 'Brian Otieno', 57.5], [3, 'Cynthia Mwangi', 20]]);
    expect(r.unranked.map((x: any) => x.fullName)).toEqual(['Dan Njoroge']);
  });
  test('performance index, class scope spans sections', async () => {
    const r = (await rank(`sectionId=${S.B}&kind=index&scope=class`)).body;
    expect(r.items.map((x: any) => [x.rank, x.fullName])).toEqual([[1, 'Amina Ali'], [2, 'Carl Kamau'], [3, 'Brian Otieno'], [4, 'Cynthia Mwangi']]);
    expect(r.sections).toEqual(['1B', '1C']);
  });
  test('assessment ranking uses complete assessments only', async () => {
    const r = (await rank(`sectionId=${S.B}&kind=assessment&term=1`)).body;
    expect(r.items.map((x: any) => [x.rank, x.fullName, x.marks, x.max])).toEqual([[1, 'Amina Ali', 30, 30], [2, 'Brian Otieno', 15, 30], [3, 'Cynthia Mwangi', 6, 30]]);
    expect(r.unranked.map((x: any) => x.fullName)).toEqual(['Dan Njoroge']); // partial is not ranked
  });
  test('exam ranking in one section', async () => {
    const r = (await rank(`sectionId=${S.B}&kind=exam&examId=${X.t1B}`)).body;
    expect(r.title).toBe('Term 1 Physics Examination');
    expect(r.items.map((x: any) => [x.rank, x.fullName, x.marks, x.max, x.percent])).toEqual([
      [1, 'Amina Ali', 45, 50, 90],
      [2, 'Brian Otieno', 20, 50, 40],
      [3, 'Cynthia Mwangi', 10, 50, 20],
    ]);
  });
  test('class-scope exam ranking compares percentages, so ties share a rank (1, 1, 3, 4)', async () => {
    const r = (await rank(`sectionId=${S.B}&kind=exam&examId=${X.t1B}&scope=class`)).body;
    expect(r.items.map((x: any) => [x.rank, x.fullName, x.percent])).toEqual([
      [1, 'Amina Ali', 90],
      [1, 'Carl Kamau', 90],
      [3, 'Brian Otieno', 40],
      [4, 'Cynthia Mwangi', 20],
    ]);
    expect(r.unranked.map((x: any) => x.fullName)).toEqual(['Dan Njoroge']);
  });
  test('validation and scoping', async () => {
    expect((await rank(`sectionId=${S.B}&kind=assessment`)).status).toBe(400);
    expect((await rank(`sectionId=${S.B}&kind=exam`)).status).toBe(400);
    expect((await rank(`sectionId=${S.C}&kind=exam&examId=${X.t1B}`)).status).toBe(400); // exam of another section
    expect((await other.get(`/rankings?academicYearId=${year}&sectionId=${S.B}&kind=index`)).status).toBe(403);
    expect((await other.get(`/analytics/section?academicYearId=${year}&sectionId=${S.B}`)).status).toBe(403);
    expect((await other.get(`/students/${E.amina}/profile`)).status).toBe(403);
    expect((await other.get(`/students/${E.carl}/profile`)).status).toBe(200);
  });
});

describe('student access: own records only', () => {
  let amina: Client;
  let brian: Client;
  let dan: Client;
  beforeAll(async () => {
    amina = t.client();
    brian = t.client();
    dan = t.client();
    expect((await amina.loginStudent('t-1001')).status).toBe(200);
    expect((await brian.loginStudent('T-1002')).status).toBe(200);
    expect((await dan.loginStudent('T-1004')).status).toBe(200);
  });

  test('a student sees their own profile, assessment, exams and history', async () => {
    const years = (await teacher.get('/academic-years')).body;
    const y1 = years.find((y: any) => y.label === '2026/2027').id;
    const y2 = years.find((y: any) => y.label === '2027/2028').id;
    const p = (await amina.get('/me/profile')).body; // defaults to the ACTIVE year (2026/2027); 2027/2028 is only planned
    expect(p.student.studentId).toBe('T-1001');
    expect(p.academicYear.label).toBe('2026/2027');
    expect(p.terms[0].components.map((c: any) => [c.marks, c.max])).toEqual([[30, 30], [45, 50]]);
    expect(p.overallIndex).toBe(92.5);
    expect(p.history.map((h: any) => [h.academicYearLabel, h.sectionLabel, h.overallIndex])).toEqual([['2027/2028', '1D', null]]);
    const next = (await amina.get(`/me/profile?academicYearId=${y2}`)).body;
    expect(next.section.label).toBe('1D');
    expect(next.history[0]).toMatchObject({ academicYearLabel: '2026/2027', overallIndex: 92.5 });
    expect((await amina.get(`/me/profile?academicYearId=${y1}`)).body.overallIndex).toBe(92.5);
    expect((await amina.get('/me/years')).body.map((y: any) => y.academicYearLabel)).toEqual(['2027/2028', '2026/2027']);
  });
  test('the student view has no teacher-only analysis and never contains another student', async () => {
    const body = (await brian.get('/me/profile')).body;
    const json = JSON.stringify(body);
    expect(body.student.studentId).toBe('T-1002');
    expect(body.flags).toBeUndefined();
    expect(body.basis).toBeUndefined();
    for (const forbidden of ['T-1001', 'T-1003', 'T-2001', 'Amina', 'Cynthia', 'Carl']) expect(json).not.toContain(forbidden);
  });
  test('incomplete (partial) assessment marks are not shown to students', async () => {
    const p = (await dan.get('/me/profile')).body;
    expect(p.terms[0].components[0]).toMatchObject({ state: 'missing', marks: null, scores: null });
  });
  test('there is no way to ask for another student: ids in the URL are ignored or rejected', async () => {
    expect((await brian.get(`/me/profile?enrollmentId=${E.amina}`)).body.student.studentId).toBe('T-1002');
    expect((await brian.get(`/students/${E.amina}/profile`)).status).toBe(403);
    expect((await brian.get(`/me/profile?academicYearId=00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    expect((await brian.get('/me/profile?academicYearId=nonsense')).status).toBe(400);
  });
  test('students cannot reach any teacher functionality or change anything', async () => {
    for (const path of [
      '/analytics/dashboard',
      `/analytics/section?academicYearId=${year}&sectionId=${S.B}`,
      `/rankings?academicYearId=${year}&sectionId=${S.B}`,
      `/assessments/sheet?academicYearId=${year}&sectionId=${S.B}&term=1`,
      `/examinations?academicYearId=${year}`,
      `/students?academicYearId=${year}`,
      '/academic-years',
      '/classes',
      '/teachers/me',
    ]) {
      expect([path, (await brian.get(path)).status]).toEqual([path, 403]);
    }
    const write = await brian.put('/assessments/marks', { academicYearId: year, sectionId: S.B, term: 1, entries: [{ enrollmentId: E.brian, version: 1, textbook: 5 }] });
    expect(write.status).toBe(403);
    expect((await brian.put(`/examinations/${X.t1B}/marks`, { entries: [{ enrollmentId: E.brian, version: 1, marks: 50 }] })).status).toBe(403);
    expect((await brian.post('/students', { academicYearId: year, sectionId: S.B, studentId: 'HACK-1', fullName: 'X' })).status).toBe(403);
    // and nothing changed
    expect((await teacher.get(`/examinations/${X.t1B}/sheet`)).body.rows.find((r: any) => r.enrollmentId === E.brian).marks).toBe(20);
  });
  test('a teacher session cannot use the student endpoints', async () => {
    expect((await teacher.get('/me/profile')).status).toBe(403);
  });
  test('an unknown or malformed Student ID cannot log in', async () => {
    const c = t.client();
    expect((await c.loginStudent('NOPE-1')).status).toBe(401);
    expect((await c.loginStudent("T-1001' OR '1'='1")).status).toBe(401);
    expect((await c.get('/me/profile')).status).toBe(401);
  });
});
