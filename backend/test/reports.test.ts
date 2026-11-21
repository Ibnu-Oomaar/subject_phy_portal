import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import ExcelJS from 'exceljs';
import { Client, startApp, type Res, type TestApp } from './helpers';

let t: TestApp;
let teacher: Client; // all sections
let other: Client; // only 1C
const S: Record<string, string> = {};
const E: Record<string, string> = {};
let year1 = '';
let examB = '';
let examC = '';
let quizB = '';

const book = async (r: Res): Promise<ExcelJS.Workbook> => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.raw as unknown as ExcelJS.Buffer);
  return wb;
};
/** Reads a sheet written by ExcelService.addTable: headings are on row 4, data starts on row 5. */
const table = (wb: ExcelJS.Workbook, sheet: string): Array<Record<string, any>> => {
  const ws = wb.getWorksheet(sheet);
  if (!ws) throw new Error(`No sheet "${sheet}". Sheets: ${wb.worksheets.map((s) => s.name).join(', ')}`);
  const headers: Record<number, string> = {};
  ws.getRow(4).eachCell((c, n) => (headers[n] = String(c.value)));
  const rows: Array<Record<string, any>> = [];
  for (let r = 5; r <= ws.rowCount; r++) {
    const obj: Record<string, any> = {};
    let any = false;
    for (const [n, h] of Object.entries(headers)) {
      const v = ws.getCell(r, Number(n)).value;
      obj[h] = v ?? null;
      if (v !== null && v !== undefined) any = true;
    }
    if (any) rows.push(obj);
  }
  return rows;
};
const keyValues = (wb: ExcelJS.Workbook, sheet: string): Record<string, any> => {
  const ws = wb.getWorksheet(sheet)!;
  const out: Record<string, any> = {};
  for (let r = 4; r <= ws.rowCount; r++) {
    const k = ws.getCell(r, 1).value;
    if (k) out[String(k)] = ws.getCell(r, 2).value ?? null;
  }
  return out;
};
const ex = (c: Client, type: string, q: Record<string, string | undefined> = {}) => {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined) as Array<[string, string]>).toString();
  return c.get(`/exports/${type}${qs ? `?${qs}` : ''}`);
};
const byId = (rows: Array<Record<string, any>>, id: string) => rows.find((r) => r['Student ID'] === id);

beforeAll(async () => {
  t = await startApp();
  await t.teachers.create({ name: 'Ms Test' });
  await t.teachers.create({ name: 'Mr Other', sectionLabels: ['1C'] });
  teacher = t.client();
  other = t.client();
  expect((await teacher.loginTeacher('Ms Test')).status).toBe(200);
  expect((await other.loginTeacher('Mr Other')).status).toBe(200);
  for (const sec of (await teacher.get('/classes')).body[0].sections) S[sec.code] = sec.id;
  year1 = (await teacher.post('/academic-years', { label: '2026/2027' })).body.id;
  const enroll = async (key: string, section: string, studentId: string, fullName: string) => {
    const r = await teacher.post('/students', { academicYearId: year1, sectionId: S[section], studentId, fullName });
    expect(r.status).toBe(201);
    E[key] = r.body.enrollmentId;
  };
  await enroll('amina', 'B', 'T-1001', 'Amina Ali');
  await enroll('brian', 'B', 'T-1002', 'Brian Otieno');
  await enroll('cynthia', 'B', 'T-1003', 'Cynthia Mwangi');
  await enroll('carl', 'C', 'T-2001', 'Carl Kamau');
  await enroll('inj', 'D', 'T-3001', '=HYPERLINK("http://evil.example","click")');

  const full = { classActivities: 9, homeworkAssignments: 6, learningMaterialsNotebook: 10, textbook: 5 };
  const putA = (section: string, enrollmentId: string, values: Record<string, number>) =>
    teacher.put('/assessments/marks', { academicYearId: year1, sectionId: S[section], term: 1, entries: [{ enrollmentId, version: 0, ...values }] });
  expect((await putA('B', E.amina!, full)).status).toBe(200); // 30
  expect((await putA('B', E.brian!, { classActivities: 4, homeworkAssignments: 3 })).status).toBe(200); // partial
  expect((await putA('C', E.carl!, { classActivities: 8, homeworkAssignments: 5, learningMaterialsNotebook: 9, textbook: 5 })).status).toBe(200); // 27

  expect((await teacher.post('/examinations', { academicYearId: year1, sectionIds: [S.B, S.C], term: 1, name: 'Term 1 Physics Examination', maxMarks: 50, examDate: '2026-04-20' })).status).toBe(201);
  expect((await teacher.post('/examinations', { academicYearId: year1, sectionId: S.B, term: 1, name: 'Quiz', maxMarks: 37.5, examDate: '2026-03-01' })).status).toBe(201);
  const exams: Array<{ id: string; name: string; section_id: string }> = await t.ds.query(`SELECT id, name, section_id FROM examinations`);
  examB = exams.find((x) => x.name.startsWith('Term 1') && x.section_id === S.B)!.id;
  examC = exams.find((x) => x.name.startsWith('Term 1') && x.section_id === S.C)!.id;
  quizB = exams.find((x) => x.name === 'Quiz')!.id;
  const putE = (id: string, entries: Array<[string, number]>) =>
    teacher.put(`/examinations/${id}/marks`, { entries: entries.map(([k, marks]) => ({ enrollmentId: E[k], version: 0, marks })) });
  expect((await putE(examB, [['amina', 45], ['brian', 30]])).status).toBe(200); // cynthia: missing
  expect((await putE(examC, [['carl', 40]])).status).toBe(200);
  expect((await putE(quizB, [['amina', 30]])).status).toBe(200);
});

afterAll(async () => {
  await t.close();
});

describe('access control', () => {
  test('anonymous users and students cannot export; unknown types and bad ids are rejected', async () => {
    expect((await ex(t.client(), 'students')).status).toBe(401);
    const student = t.client();
    expect((await student.loginStudent('T-1001')).status).toBe(200);
    expect((await ex(student, 'students')).status).toBe(403);
    expect((await ex(student, 'student-result', { enrollmentId: E.amina })).status).toBe(403);
    expect((await ex(teacher, 'everything')).status).toBe(400);
    expect((await ex(teacher, 'assessments', { academicYearId: 'nope', sectionId: S.B })).status).toBe(400);
    const noYear = await ex(teacher, 'assessments', { sectionId: S.B });
    expect(noYear.status).toBe(400);
    expect(noYear.body.error.code).toBe('YEAR_REQUIRED');
  });

  test('a teacher cannot export sections they are not assigned to, whatever the type', async () => {
    for (const type of ['assessments', 'exam-marks', 'rankings', 'academic-year-report', 'class-performance', 'students']) {
      const r = await ex(other, type, { academicYearId: year1, sectionId: S.B, term: '1' });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('SECTION_NOT_ASSIGNED');
    }
    const r = await ex(other, 'student-result', { enrollmentId: E.amina });
    expect([403, 404]).toContain(r.status);
  });
});

describe('students export', () => {
  test('all students, limited to the teacher\'s own sections', async () => {
    const r = await ex(teacher, 'students', { academicYearId: year1 });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('spreadsheetml');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="Physics_students_2026-2027_All-sections\.xlsx"$/);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const rows = table(await book(r), 'Students');
    expect(rows.map((x) => x['Student ID']).sort()).toEqual(['T-1001', 'T-1002', 'T-1003', 'T-2001', 'T-3001']);
    expect(byId(rows, 'T-1001')).toMatchObject({ 'Student Name': 'Amina Ali', Class: 'Class 1', Section: '1B', 'Academic Year': '2026/2027', 'Year Status': 'Active' });

    const mine = table(await book(await ex(other, 'students', { academicYearId: year1 })), 'Students');
    expect(mine.map((x) => x['Student ID'])).toEqual(['T-2001']);
    const everyYear = table(await book(await ex(other, 'students')), 'Students');
    expect(everyYear.map((x) => x['Student ID'])).toEqual(['T-2001']);
  });

  test('one section, or the whole class', async () => {
    const section = table(await book(await ex(teacher, 'students', { academicYearId: year1, sectionId: S.B })), 'Students');
    expect(section.map((x) => x['Student ID']).sort()).toEqual(['T-1001', 'T-1002', 'T-1003']);
    const cls = await ex(teacher, 'students', { academicYearId: year1, sectionId: S.B, scope: 'class' });
    expect(table(await book(cls), 'Students')).toHaveLength(5);
    expect(cls.headers.get('content-disposition')).toContain('Class-1');
  });

  test('names that look like formulas are neutralised in the file', async () => {
    const rows = table(await book(await ex(teacher, 'students', { academicYearId: year1, sectionId: S.D })), 'Students');
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!['Student Name']).startsWith("'=")).toBe(true);
    const cell = (await book(await ex(teacher, 'students', { academicYearId: year1, sectionId: S.D }))).getWorksheet('Students')!.getCell(5, 2);
    expect(typeof cell.value).toBe('string'); // a plain string, not a formula object
  });
});

describe('assessment export', () => {
  test('missing is blank (never 0), partial has no total, complete shows total and percentage', async () => {
    const wb = await book(await ex(teacher, 'assessments', { academicYearId: year1, sectionId: S.B }));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Term 1', 'Term 2', 'Final Term 3']);
    const rows = table(wb, 'Term 1');
    expect(rows).toHaveLength(3);
    expect(byId(rows, 'T-1001')).toMatchObject({
      'Class Activities (/9)': 9,
      'Homeworks and Assignments (/6)': 6,
      'Learning Materials and Notebook (/10)': 10,
      'Textbook (/5)': 5,
      'Total (/30)': 30,
      'Percentage (%)': 100,
      Status: 'Entered',
    });
    expect(byId(rows, 'T-1002')).toMatchObject({ 'Class Activities (/9)': 4, 'Homeworks and Assignments (/6)': 3, 'Learning Materials and Notebook (/10)': null, 'Textbook (/5)': null, 'Total (/30)': null, 'Percentage (%)': null, Status: 'Partial' });
    expect(byId(rows, 'T-1003')).toMatchObject({ 'Class Activities (/9)': null, 'Total (/30)': null, 'Percentage (%)': null, Status: 'Missing' });
    // no cell anywhere in Terms 2 and 3 holds a zero: nothing was entered there
    for (const name of ['Term 2', 'Final Term 3']) {
      for (const row of table(wb, name)) {
        expect(Object.entries(row).filter(([k, v]) => !['Student ID', 'Student Name', 'Section', 'Status'].includes(k) && v !== null)).toEqual([]);
        expect(row.Status).toBe('Missing');
      }
    }
  });

  test('a single term, and class scope with students from every section', async () => {
    const wb = await book(await ex(teacher, 'assessments', { academicYearId: year1, sectionId: S.B, scope: 'class', term: '1' }));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Term 1']);
    const rows = table(wb, 'Term 1');
    expect(rows).toHaveLength(5);
    expect(byId(rows, 'T-2001')).toMatchObject({ 'Total (/30)': 27, 'Percentage (%)': 90, Section: '1C' });
  });

  test('the export reflects edits made afterwards (no stale cache)', async () => {
    const before = byId(table(await book(await ex(teacher, 'assessments', { academicYearId: year1, sectionId: S.B, term: '1' })), 'Term 1'), 'T-1002')!;
    expect(before['Total (/30)']).toBeNull();
    const sheet = (await teacher.get(`/assessments/sheet?academicYearId=${year1}&sectionId=${S.B}&term=1`)).body;
    const version = sheet.rows.find((r: any) => r.enrollmentId === E.brian).version;
    expect((await teacher.put('/assessments/marks', { academicYearId: year1, sectionId: S.B, term: 1, entries: [{ enrollmentId: E.brian, version, learningMaterialsNotebook: 7, textbook: 4 }] })).status).toBe(200);
    const after = byId(table(await book(await ex(teacher, 'assessments', { academicYearId: year1, sectionId: S.B, term: '1' })), 'Term 1'), 'T-1002')!;
    expect(after).toMatchObject({ 'Total (/30)': 18, 'Percentage (%)': 60, Status: 'Entered' }); // 4 + 3 + 7 + 4
  });
});

describe('examination export', () => {
  test('uses each examination\'s own maximum, and leaves missing marks blank', async () => {
    const wb = await book(await ex(teacher, 'exam-marks', { academicYearId: year1, sectionId: S.B, term: '1' }));
    const rows = table(wb, 'Term 1 exams');
    // two examinations in 1B x 3 students each
    expect(rows).toHaveLength(6);
    const main = rows.filter((r) => String(r.Examination).startsWith('Term 1 Physics'));
    expect(main.map((r) => r['Maximum'])).toEqual([50, 50, 50]);
    expect(byId(main, 'T-1001')).toMatchObject({ Marks: 45, 'Percentage (%)': 90, Status: 'Entered' });
    expect(byId(main, 'T-1003')).toMatchObject({ Marks: null, 'Percentage (%)': null, Status: 'Missing' });
    const quiz = rows.filter((r) => r.Examination === 'Quiz');
    expect(quiz.map((r) => r['Maximum'])).toEqual([37.5, 37.5, 37.5]);
    expect(byId(quiz, 'T-1001')).toMatchObject({ Marks: 30, 'Percentage (%)': 80 });
    expect(byId(quiz, 'T-1002')).toMatchObject({ Marks: null, Status: 'Missing' });
    // exams are ordered by date: the quiz (March) comes before the main examination (April)
    expect(rows[0]!.Examination).toBe('Quiz');
  });

  test('a term is required, an unknown or foreign examination is a 404, and a specific examination can be exported', async () => {
    expect((await ex(teacher, 'exam-marks', { academicYearId: year1, sectionId: S.B })).body.error.code).toBe('TERM_REQUIRED');
    expect((await ex(teacher, 'exam-marks', { academicYearId: year1, sectionId: S.B, examId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    // examB is in 1B: the teacher of 1C only cannot reach it by naming it
    expect([403, 404]).toContain((await ex(other, 'exam-marks', { academicYearId: year1, examId: examB })).status);
    const one = table(await book(await ex(teacher, 'exam-marks', { academicYearId: year1, sectionId: S.B, examId: quizB })), 'Term 1 exams');
    expect(one).toHaveLength(3);
  });

  test('a term with no examinations produces an empty, labelled sheet rather than invented rows', async () => {
    const wb = await book(await ex(teacher, 'exam-marks', { academicYearId: year1, sectionId: S.B, term: '2' }));
    expect(wb.getWorksheet('Term 2 exams')!.getCell(5, 1).value).toBe('No records match this selection.');
  });
});

describe('individual results', () => {
  test('summary, results, categories, term averages', async () => {
    const r = await ex(teacher, 'student-result', { enrollmentId: E.amina });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toContain('student-result_T-1001_2026-2027');
    const wb = await book(r);
    const summary = keyValues(wb, 'Summary');
    expect(summary).toMatchObject({ 'Student ID': 'T-1001', 'Student name': 'Amina Ali', Section: '1B', Class: 'Class 1', 'Academic year': '2026/2027 (Active)' });
    // Term 1 = mean(assessment 100%, exam 90%, quiz 80%) = 90 ; other terms have nothing, so the index is 90, not diluted by zeros
    expect(summary['Performance index (%)']).toBe(90);
    expect(String(summary['How the index is calculated'])).toContain('not a final grade');

    const results = table(wb, 'Results');
    const t1 = results.filter((x) => x.Term === 'Term 1');
    expect(t1.map((x) => x.Result).sort()).toEqual(['Quiz', 'Term 1 assessment', 'Term 1 Physics Examination'].sort());
    expect(t1.find((x) => x.Result === 'Quiz')).toMatchObject({ Marks: 30, Maximum: 37.5, 'Percentage (%)': 80 });
    const t2 = results.filter((x) => x.Term === 'Term 2');
    expect(t2).toHaveLength(1);
    expect(t2[0]).toMatchObject({ Marks: null, 'Percentage (%)': null, Status: 'Missing' });

    expect(table(wb, 'Assessment categories')[0]).toMatchObject({ Term: 'Term 1', 'Total (/30)': 30 });
    expect(table(wb, 'Term averages').map((x) => x['Average (%)'])).toEqual([90, null, null]);
    expect(wb.getWorksheet('Other academic years')).toBeUndefined(); // nothing to show yet
  });

  test('a student with nothing entered exports blanks and no index', async () => {
    const wb = await book(await ex(teacher, 'student-result', { enrollmentId: E.cynthia }));
    expect(keyValues(wb, 'Summary')['Performance index (%)']).toBeNull();
    expect(table(wb, 'Term averages').every((x) => x['Average (%)'] === null)).toBe(true);
  });

  test('the student is required and must exist', async () => {
    expect((await ex(teacher, 'student-result')).body.error.code).toBe('STUDENT_REQUIRED');
    expect((await ex(teacher, 'student-result', { enrollmentId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
  });
});

describe('rankings export', () => {
  test('performance index ranking lists unranked students separately, never as zero', async () => {
    const wb = await book(await ex(teacher, 'rankings', { academicYearId: year1, sectionId: S.B }));
    const ranking = table(wb, 'Ranking');
    expect(ranking[0]).toMatchObject({ Rank: 1, 'Student ID': 'T-1001', 'Percentage (%)': 90 });
    expect(ranking.some((r) => r['Student ID'] === 'T-1003')).toBe(false);
    expect(table(wb, 'Not ranked').map((r) => r['Student ID'])).toContain('T-1003');
  });

  test('assessment ranking for the whole class: standard competition ranking across sections', async () => {
    const rows = table(await book(await ex(teacher, 'rankings', { academicYearId: year1, sectionId: S.B, scope: 'class', kind: 'assessment', term: '1' })), 'Ranking');
    expect(rows.map((r) => [r['Student ID'], r.Rank, r.Marks, r.Maximum])).toEqual([
      ['T-1001', 1, 30, 30],
      ['T-2001', 2, 27, 30],
      ['T-1002', 3, 18, 30],
    ]);
  });

  test('examination ranking uses the percentage of that examination\'s own maximum', async () => {
    const rows = table(await book(await ex(teacher, 'rankings', { academicYearId: year1, sectionId: S.B, kind: 'exam', examId: quizB })), 'Ranking');
    expect(rows).toEqual([expect.objectContaining({ Rank: 1, 'Student ID': 'T-1001', Marks: 30, Maximum: 37.5, 'Percentage (%)': 80 })]);
  });

  test('required parameters are explained', async () => {
    expect((await ex(teacher, 'rankings', { academicYearId: year1, sectionId: S.B, kind: 'assessment' })).body.error.code).toBe('TERM_REQUIRED');
    expect((await ex(teacher, 'rankings', { academicYearId: year1, sectionId: S.B, kind: 'exam' })).body.error.code).toBe('EXAM_REQUIRED');
    expect((await ex(teacher, 'rankings', { academicYearId: year1 })).body.error.code).toBe('SECTION_REQUIRED');
  });
});

describe('academic year report and class performance', () => {
  test('academic-year report: overview, sections, students, examinations', async () => {
    const wb = await book(await ex(teacher, 'academic-year-report', { academicYearId: year1 }));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Overview', 'Sections', 'Student results', 'Examinations']);
    const o = keyValues(wb, 'Overview');
    expect(o).toMatchObject({ 'Academic year': '2026/2027', Status: 'Active', 'Students enrolled': 5, 'Examinations created': 3 });
    expect(o['Term 1 assessments complete']).toBe('3 of 5'); // amina, brian (now complete), carl
    expect(o['Students without any complete result']).toBe(2); // cynthia and the formula-named student
    const students = table(wb, 'Student results');
    expect(students).toHaveLength(5);
    expect(byId(students, 'T-1001')).toMatchObject({ 'Term 1 assessment (/30)': 30, 'Term 1 average (%)': 90, 'Performance index (%)': 90 });
    expect(byId(students, 'T-1003')).toMatchObject({ 'Term 1 assessment (/30)': null, 'Performance index (%)': null });
    const exams = table(wb, 'Examinations');
    const mainB = exams.find((x) => x.Examination.startsWith('Term 1') && x.Section === '1B')!;
    expect(mainB).toMatchObject({ Maximum: 50, Students: 3, Entered: 2, Missing: 1, Average: 37.5, 'Average (%)': 75, Highest: 45, Lowest: 30 });
    expect(table(wb, 'Sections').map((s) => s.Section)).toEqual(['1B', '1C', '1D', '1E', '1F', '1G', '1H']);
  });

  test('academic-year report for the other teacher contains only their section', async () => {
    const wb = await book(await ex(other, 'academic-year-report', { academicYearId: year1 }));
    expect(table(wb, 'Student results').map((r) => r['Student ID'])).toEqual(['T-2001']);
    expect(keyValues(wb, 'Overview')['Students enrolled']).toBe(1);
    expect(table(wb, 'Examinations').every((x) => x.Section === '1C')).toBe(true);
  });

  test('class performance matches the analytics endpoint', async () => {
    const api = (await teacher.get(`/analytics/section?academicYearId=${year1}&sectionId=${S.B}`)).body;
    const wb = await book(await ex(teacher, 'class-performance', { academicYearId: year1, sectionId: S.B }));
    expect(wb.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(['Summary', 'Ranking', 'Assessments', 'Examinations', 'Distribution', 'Monitoring']));
    const summary = keyValues(wb, 'Summary');
    expect(summary['Section average index (%)']).toBe(api.sectionAverage.average);
    expect(summary['Students in section']).toBe(api.totals.students);
    expect(table(wb, 'Ranking').map((r) => [r.Rank, r['Student ID']])).toEqual(api.ranking.map((r: any) => [r.rank, r.studentId]));
    const assessments = table(wb, 'Assessments');
    expect(assessments[0]).toMatchObject({ Term: 'Term 1', Students: 3, Missing: 1 });
    expect(assessments[1]).toMatchObject({ Term: 'Term 2', Complete: 0, 'Average (/30)': null });
    const dist = table(wb, 'Distribution');
    expect(dist.reduce((s, r) => s + Number(r.Students), 0)).toBe(api.distribution.reduce((s: number, d: any) => s + d.count, 0));
  });
});
