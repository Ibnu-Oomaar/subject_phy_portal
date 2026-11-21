import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client, startApp, type TestApp } from './helpers';

let t: TestApp;
let teacher: Client;
let other: Client; // a second teacher who is only assigned to 1C
const S: Record<string, string> = {}; // section label -> id
const E: Record<string, string> = {}; // student key -> enrollment id
let year1 = '';
let year2 = '';

const full = { classActivities: 9, homeworkAssignments: 6, learningMaterialsNotebook: 10, textbook: 5 };
const save = (c: Client, enrollmentId: string, version: number, term: number, values: Record<string, unknown>, extra: Record<string, unknown> = {}, section = 'B', yearId = year1) =>
  c.put('/assessments/marks', { academicYearId: yearId, sectionId: S[section], term, ...extra, entries: [{ enrollmentId, version, ...values }] });
const sheet = async (term: number, query = '') =>
  (await teacher.get(`/assessments/sheet?academicYearId=${year1}&sectionId=${S.B}&term=${term}${query}`)).body;
const row = (s: any, key: string) => s.rows.find((r: any) => r.enrollmentId === E[key]);

beforeAll(async () => {
  t = await startApp();
  await t.teachers.create({ name: 'Ms Test' });
  await t.teachers.create({ name: 'Mr Other', sectionLabels: ['1C'] });
  teacher = t.client();
  other = t.client();
  expect((await teacher.loginTeacher('Ms Test')).status).toBe(200);
  expect((await other.loginTeacher('Mr Other')).status).toBe(200);
  const classes = (await teacher.get('/classes')).body;
  for (const sec of classes[0].sections) S[sec.code] = sec.id;
  const y1 = await teacher.post('/academic-years', { label: '2026/2027' });
  const y2 = await teacher.post('/academic-years', { label: '2027/2028' });
  year1 = y1.body.id;
  year2 = y2.body.id;
  const enroll = async (key: string, section: string, studentId: string, fullName: string) => {
    const r = await teacher.post('/students', { academicYearId: year1, sectionId: S[section], studentId, fullName });
    expect(r.status).toBe(201);
    E[key] = r.body.enrollmentId;
  };
  await enroll('amina', 'B', 'T-1001', 'Amina Ali');
  await enroll('brian', 'B', 'T-1002', 'Brian Otieno');
  await enroll('cynthia', 'B', 'T-1003', 'Cynthia Mwangi');
  await enroll('carl', 'C', 'T-2001', 'Carl Kamau');
});

afterAll(async () => {
  await t.close();
});

describe('setup', () => {
  test('first academic year is active, later ones are planned; sections B-H exist', async () => {
    expect(year1).toBeTruthy();
    const years = (await teacher.get('/academic-years')).body;
    expect(years.find((y: any) => y.id === year1).status).toBe('active');
    expect(years.find((y: any) => y.id === year2).status).toBe('planned');
    expect(Object.keys(S).sort()).toEqual(['B', 'C', 'D', 'E', 'F', 'G', 'H']);
  });
  test('student list only shows the selected section and is paginated', async () => {
    const r = (await teacher.get(`/students?academicYearId=${year1}&sectionId=${S.B}&pageSize=2`)).body;
    expect(r.total).toBe(3);
    expect(r.items).toHaveLength(2);
    expect(r.items.every((i: any) => i.sectionLabel === '1B')).toBe(true);
  });
  test('a duplicate enrolment and a malformed Student ID are rejected', async () => {
    const dup = await teacher.post('/students', { academicYearId: year1, sectionId: S.C, studentId: 't-1001', fullName: 'Whoever' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE');
    const bad = await teacher.post('/students', { academicYearId: year1, sectionId: S.B, studentId: 'a b!', fullName: 'X' });
    expect(bad.status).toBe(400);
  });
});

describe('assessments: fixed 30-mark structure', () => {
  test('exposes the four fixed categories (9, 6, 10, 5) with total 30', async () => {
    const r = (await teacher.get('/assessments/categories')).body;
    expect(r.categories.map((c: any) => c.maxMarks)).toEqual([9, 6, 10, 5]);
    expect(r.maxTotal).toBe(30);
    expect((await teacher.put('/assessments/categories', {})).status).toBe(404); // no API can change them
  });
  test('every student starts as missing with no total (not zero)', async () => {
    const s = await sheet(1);
    expect(s.rows).toHaveLength(3);
    expect(s.rows.every((r: any) => r.state === 'missing' && r.total === null && r.percent === null)).toBe(true);
    expect(s.summary).toMatchObject({ students: 3, missing: 3 });
  });
  test('the backend rejects values above the maximum, negatives, >2 decimals and non-numbers', async () => {
    const over = await save(teacher, E.amina!, 0, 1, { classActivities: 9.5 });
    expect(over.status).toBe(400);
    expect(over.body.error.details[0].path).toBe('entries.0.classActivities');
    expect((await save(teacher, E.amina!, 0, 1, { homeworkAssignments: 7 })).status).toBe(400);
    expect((await save(teacher, E.amina!, 0, 1, { learningMaterialsNotebook: 10.01 })).status).toBe(400);
    expect((await save(teacher, E.amina!, 0, 1, { textbook: 5.5 })).status).toBe(400);
    expect((await save(teacher, E.amina!, 0, 1, { textbook: -1 })).status).toBe(400);
    expect((await save(teacher, E.amina!, 0, 1, { textbook: 2.555 })).status).toBe(400);
    expect((await save(teacher, E.amina!, 0, 1, { textbook: '4' })).status).toBe(400);
    expect((await save(teacher, E.amina!, 0, 4, { textbook: 4 })).status).toBe(400); // only terms 1-3
    expect((await sheet(1)).summary.missing).toBe(3); // nothing was saved
  });
  test('saves a complete record: total 30, 100 %, state entered', async () => {
    const r = await save(teacher, E.amina!, 0, 1, full);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 1, updated: 0, unchanged: 0 });
    const amina = row(await sheet(1), 'amina');
    expect(amina).toMatchObject({ total: 30, percent: 100, state: 'entered', version: 1 });
  });
  test('partial entry is partial, has a provisional total but no percentage', async () => {
    expect((await save(teacher, E.brian!, 0, 1, { classActivities: 4.5 })).status).toBe(200);
    expect(row(await sheet(1), 'brian')).toMatchObject({ state: 'partial', total: 4.5, percent: null });
  });
  test('the missing-marks view lists only students without marks', async () => {
    const s = await sheet(1, '&state=missing');
    expect(s.rows.map((r: any) => r.fullName)).toEqual(['Cynthia Mwangi']);
  });
  test('an explicit 0 is a real mark, not missing', async () => {
    expect((await save(teacher, E.cynthia!, 0, 2, { classActivities: 0, homeworkAssignments: 0, learningMaterialsNotebook: 0, textbook: 0 })).status).toBe(200);
    expect(row(await sheet(2), 'cynthia')).toMatchObject({ total: 0, percent: 0, state: 'entered' });
    expect((await save(teacher, E.cynthia!, 1, 2, { classActivities: null })).status).toBe(200); // clear again
    expect(row(await sheet(2), 'cynthia')).toMatchObject({ state: 'partial', total: 0 });
    expect((await save(teacher, E.cynthia!, 2, 2, { homeworkAssignments: null, learningMaterialsNotebook: null, textbook: null })).status).toBe(200);
    expect(row(await sheet(2), 'cynthia')).toMatchObject({ state: 'missing', total: null });
  });
  test('saving identical values changes nothing (no version bump)', async () => {
    const r = await save(teacher, E.amina!, 1, 1, full);
    expect(r.body).toMatchObject({ unchanged: 1, updated: 0 });
    expect(row(await sheet(1), 'amina').version).toBe(1);
  });
  test('stale or wrong versions are refused with CONCURRENT_MODIFICATION', async () => {
    const r = await save(teacher, E.amina!, 0, 1, { textbook: 3 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CONCURRENT_MODIFICATION');
    expect(r.body.error.details.conflicts[0]).toMatchObject({ expectedVersion: 0, currentVersion: 1 });
    expect(row(await sheet(1), 'amina').scores.textbook).toBe(5);
  });
  test('students from another section can never receive marks', async () => {
    const r = await save(teacher, E.carl!, 0, 1, { textbook: 3 }, {}, 'B');
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('ENROLLMENT_MISMATCH');
  });
  test('a teacher cannot enter marks for a section that is not assigned to them', async () => {
    const r = await save(other, E.amina!, 0, 1, { textbook: 3 }, {}, 'B');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('SECTION_NOT_ASSIGNED');
    expect((await other.get(`/assessments/sheet?academicYearId=${year1}&sectionId=${S.B}&term=1`)).status).toBe(403);
    expect((await other.get(`/students?academicYearId=${year1}&sectionId=${S.B}`)).status).toBe(403);
    const mine = await other.get(`/students?academicYearId=${year1}`);
    expect(mine.body.items.map((i: any) => i.sectionLabel)).toEqual(['1C']); // default view is only their own section
  });
  test('two simultaneous saves of the same new record: exactly one wins', async () => {
    const [a, b] = await Promise.all([
      save(teacher, E.cynthia!, 0, 3, { classActivities: 3 }),
      save(teacher, E.cynthia!, 0, 3, { classActivities: 8 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.error.code).toBe('CONCURRENT_MODIFICATION');
  });
  test('two simultaneous saves of an existing record: exactly one wins', async () => {
    const [a, b] = await Promise.all([
      save(teacher, E.cynthia!, 1, 3, { homeworkAssignments: 2 }),
      save(teacher, E.cynthia!, 1, 3, { homeworkAssignments: 5 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });
});

describe('assessments: finalization, corrections and history', () => {
  test('finalize locks complete records and reports incomplete and missing ones', async () => {
    await save(teacher, E.amina!, 0, 2, full);
    await save(teacher, E.brian!, 0, 2, { classActivities: 5 });
    const r = await teacher.post('/assessments/finalize', { academicYearId: year1, sectionId: S.B, term: 2 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ finalized: 1, alreadyFinalized: 0, incomplete: 1, missing: 1 });
    const again = await teacher.post('/assessments/finalize', { academicYearId: year1, sectionId: S.B, term: 2 });
    expect(again.body).toEqual({ finalized: 0, alreadyFinalized: 1, incomplete: 1, missing: 1 });
    expect(row(await sheet(2), 'amina').state).toBe('finalized');
  });
  test('a finalized result cannot be edited without a correction reason', async () => {
    const v = row(await sheet(2), 'amina').version;
    const r = await save(teacher, E.amina!, v, 2, { classActivities: 7 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('RECORD_LOCKED');
    expect(row(await sheet(2), 'amina').scores.classActivities).toBe(9);
  });
  test('an authorized correction works, stays finalized and is audited with its reason', async () => {
    const v = row(await sheet(2), 'amina').version;
    const r = await save(teacher, E.amina!, v, 2, { classActivities: 7 }, { correctionReason: 'Marking error found on re-check' });
    expect(r.status).toBe(200);
    expect(r.body.corrected).toBe(1);
    const a = row(await sheet(2), 'amina');
    expect(a).toMatchObject({ state: 'finalized', total: 28, version: v + 1 });
    const h = (await teacher.get(`/assessments/history?enrollmentId=${E.amina}&term=2`)).body;
    expect(h.map((x: any) => x.action)).toEqual(['assessment.correction', 'assessment.finalize', 'assessment.create']);
    expect(h[0]).toMatchObject({ reason: 'Marking error found on re-check', actorName: 'Ms Test' });
    expect(h[0].before.classActivities).toBe(9);
    expect(h[0].after.classActivities).toBe(7);
  });
  test('a finalized result cannot be left incomplete, even by a correction', async () => {
    const v = row(await sheet(2), 'amina').version;
    const r = await save(teacher, E.amina!, v, 2, { textbook: null }, { correctionReason: 'Trying to blank it' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('FINALIZED_MUST_STAY_COMPLETE');
  });
  test('the database itself protects finalized rows and the fixed maximums', async () => {
    await expect(t.ds.query(`DELETE FROM assessments WHERE status = 'finalized'`)).rejects.toThrow(/Finalized records cannot be deleted/);
    await expect(t.ds.query(`UPDATE assessments SET class_activities = 10 WHERE status = 'entered'`)).rejects.toThrow();
    await expect(t.ds.query(`UPDATE assessments SET textbook = -1 WHERE status = 'entered'`)).rejects.toThrow();
  });
  test('the audit trail is append-only', async () => {
    await expect(t.ds.query(`UPDATE audit_logs SET reason = 'tampered'`)).rejects.toThrow(/append-only/);
    await expect(t.ds.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
  });
});

describe('examinations: configurable maximums', () => {
  const ids: Record<string, string> = {};
  const marks = (c: Client, examId: string, entries: Array<{ k: string; v: number; marks: number | null }>, extra: Record<string, unknown> = {}) =>
    c.put(`/examinations/${examId}/marks`, { ...extra, entries: entries.map((e) => ({ enrollmentId: E[e.k], version: e.v, marks: e.marks })) });
  const examSheet = async (id: string, q = '') => (await teacher.get(`/examinations/${id}/sheet${q}`)).body;

  test('the teacher sets the maximum for each exam: 50, 60 and 100 are only examples (37.5 works too)', async () => {
    const t1 = await teacher.post('/examinations', { academicYearId: year1, sectionIds: [S.B, S.C], term: 1, name: 'Term 1 Physics Examination', maxMarks: 50, examDate: '2026-04-20' });
    expect(t1.status).toBe(201);
    expect(t1.body.map((x: any) => [x.sectionLabel, x.maxMarks])).toEqual([['1B', 50], ['1C', 50]]);
    ids.t1 = t1.body.find((x: any) => x.sectionLabel === '1B').id;
    ids.t1c = t1.body.find((x: any) => x.sectionLabel === '1C').id;
    ids.t2 = (await teacher.post('/examinations', { academicYearId: year1, sectionId: S.B, term: 2, name: 'Term 2 Physics Examination', maxMarks: 60 })).body[0].id;
    ids.t3 = (await teacher.post('/examinations', { academicYearId: year1, sectionId: S.B, term: 3, name: 'Final Term 3 Physics Examination', maxMarks: 100 })).body[0].id;
    ids.odd = (await teacher.post('/examinations', { academicYearId: year1, sectionId: S.B, term: 1, name: 'Quiz', maxMarks: 37.5 })).body[0].id;
    const list = (await teacher.get(`/examinations?academicYearId=${year1}&sectionId=${S.B}`)).body;
    expect(list.map((x: any) => x.maxMarks).sort((a: number, b: number) => a - b)).toEqual([37.5, 50, 60, 100]);
  });
  test('validation: duplicates, bad maximum, bad term, bad date, no section', async () => {
    const dup = await teacher.post('/examinations', { academicYearId: year1, sectionId: S.B, term: 1, name: 'term 1 physics examination', maxMarks: 50 });
    expect(dup.status).toBe(409);
    expect((await teacher.post('/examinations', { academicYearId: year1, sectionId: S.B, term: 1, name: 'Z', maxMarks: 0 })).status).toBe(400);
    expect((await teacher.post('/examinations', { academicYearId: year1, sectionId: S.B, term: 1, name: 'Z', maxMarks: 1001 })).status).toBe(400);
    expect((await teacher.post('/examinations', { academicYearId: year1, sectionId: S.B, term: 1, name: 'Z', maxMarks: 10.555 })).status).toBe(400);
    expect((await teacher.post('/examinations', { academicYearId: year1, sectionId: S.B, term: 4, name: 'Z', maxMarks: 10 })).status).toBe(400);
    expect((await teacher.post('/examinations', { academicYearId: year1, sectionId: S.B, term: 1, name: 'Z', maxMarks: 10, examDate: '2026-02-31' })).status).toBe(400);
    expect((await teacher.post('/examinations', { academicYearId: year1, term: 1, name: 'Z', maxMarks: 10 })).status).toBe(400);
  });
  test('marks are validated against THIS exam maximum', async () => {
    expect((await marks(teacher, ids.t1!, [{ k: 'amina', v: 0, marks: 50.5 }])).status).toBe(400);
    expect((await marks(teacher, ids.t1!, [{ k: 'amina', v: 0, marks: -1 }])).status).toBe(400);
    expect((await marks(teacher, ids.t1!, [{ k: 'amina', v: 0, marks: 12.345 }])).status).toBe(400);
    const over = await marks(teacher, ids.t2!, [{ k: 'amina', v: 0, marks: 61 }]);
    expect(over.status).toBe(400);
    expect(over.body.error.details[0]).toMatchObject({ path: 'entries.0.marks', message: 'The maximum for this examination is 60' });
    expect((await marks(teacher, ids.t2!, [{ k: 'amina', v: 0, marks: 60 }])).status).toBe(200); // equal to max is fine
    expect((await marks(teacher, ids.odd!, [{ k: 'amina', v: 0, marks: 38 }])).status).toBe(400);
    expect((await marks(teacher, ids.odd!, [{ k: 'amina', v: 0, marks: 37.5 }])).status).toBe(200);
  });
  test('saves marks, computes percentages from the configured maximum, lists missing students', async () => {
    expect((await marks(teacher, ids.t1!, [{ k: 'amina', v: 0, marks: 45 }, { k: 'brian', v: 0, marks: 0 }])).body).toMatchObject({ created: 2 });
    const s = await examSheet(ids.t1!);
    expect(row(s, 'amina')).toMatchObject({ marks: 45, percent: 90, state: 'entered' });
    expect(row(s, 'brian')).toMatchObject({ marks: 0, percent: 0, state: 'entered' }); // zero is entered, not missing
    expect(row(s, 'cynthia')).toMatchObject({ marks: null, percent: null, state: 'missing' });
    expect(s.summary).toMatchObject({ students: 3, missing: 1, entered: 2, average: 22.5, highest: 45, lowest: 0, averagePercent: 45 });
    expect((await examSheet(ids.t1!, '?state=missing')).rows.map((r: any) => r.fullName)).toEqual(['Cynthia Mwangi']);
    const list = (await teacher.get(`/examinations?academicYearId=${year1}&sectionId=${S.B}&term=1`)).body.find((x: any) => x.id === ids.t1);
    expect(list).toMatchObject({ enrolled: 3, entered: 2, missing: 1, state: 'partial' });
  });
  test('a student from another section cannot get a mark in this exam', async () => {
    const r = await marks(teacher, ids.t1!, [{ k: 'carl', v: 0, marks: 10 }]);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('ENROLLMENT_MISMATCH');
  });
  test('the maximum cannot drop below an existing mark, but can be raised (percentages follow)', async () => {
    const low = await teacher.patch(`/examinations/${ids.t1}`, { maxMarks: 40 });
    expect(low.status).toBe(422);
    expect(low.body.error.code).toBe('MAX_BELOW_EXISTING_MARKS');
    expect((await teacher.patch(`/examinations/${ids.t1}`, { maxMarks: 60 })).status).toBe(200);
    expect(row(await examSheet(ids.t1!), 'amina').percent).toBe(75);
    expect((await teacher.patch(`/examinations/${ids.t1}`, { maxMarks: 50 })).status).toBe(200);
  });
  test('stale versions are refused; an exam with marks cannot be deleted; an empty one can', async () => {
    expect((await marks(teacher, ids.t1!, [{ k: 'amina', v: 0, marks: 44 }])).status).toBe(409);
    const del = await teacher.del(`/examinations/${ids.t1}`);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('EXAM_HAS_MARKS');
    expect((await teacher.del(`/examinations/${ids.t3}`)).status).toBe(204);
  });
  test('clearing a mark returns the student to missing (never zero)', async () => {
    const v = row(await examSheet(ids.t1!), 'brian').version;
    const r = await marks(teacher, ids.t1!, [{ k: 'brian', v, marks: null }]);
    expect(r.body).toMatchObject({ cleared: 1 });
    expect(row(await examSheet(ids.t1!), 'brian')).toMatchObject({ marks: null, state: 'missing' });
  });
  test('finalize locks marks; corrections need a reason and are audited', async () => {
    const fin = await teacher.post(`/examinations/${ids.t1}/finalize`);
    expect(fin.body).toEqual({ finalized: 1, alreadyFinalized: 0, incomplete: 0, missing: 2 });
    const v = row(await examSheet(ids.t1!), 'amina').version;
    const locked = await marks(teacher, ids.t1!, [{ k: 'amina', v, marks: 40 }]);
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('RECORD_LOCKED');
    expect((await marks(teacher, ids.t1!, [{ k: 'amina', v, marks: null }], { correctionReason: 'remove' })).status).toBe(422);
    const fixed = await marks(teacher, ids.t1!, [{ k: 'amina', v, marks: 41 }], { correctionReason: 'Addition error on page 3' });
    expect(fixed.body.corrected).toBe(1);
    const h = (await teacher.get(`/examinations/${ids.t1}/history/${E.amina}`)).body;
    expect(h.map((x: any) => x.action)).toEqual(['exam_mark.correction', 'exam_mark.finalize', 'exam_mark.create']);
    expect(h[0]).toMatchObject({ before: { marks: 45 }, after: { marks: 41 }, reason: 'Addition error on page 3' });
    const max = await teacher.patch(`/examinations/${ids.t1}`, { maxMarks: 80 });
    expect(max.status).toBe(409);
    expect(max.body.error.code).toBe('EXAM_HAS_FINALIZED_MARKS');
  });
  test('database triggers enforce the maximum and the section/year match', async () => {
    const [{ id: mark }] = await t.ds.query(`SELECT id FROM exam_marks LIMIT 1`);
    await expect(t.ds.query(`UPDATE exam_marks SET marks = 9999 WHERE id = $1`, [mark])).rejects.toThrow(/exceed the examination maximum/);
    await expect(
      t.ds.query(`INSERT INTO exam_marks (examination_id, enrollment_id, marks) VALUES ($1, $2, 1)`, [ids.t1, E.carl]),
    ).rejects.toThrow(/does not belong to the section/);
    await expect(t.ds.query(`DELETE FROM exam_marks WHERE status = 'finalized'`)).rejects.toThrow(/Finalized records cannot be deleted/);
  });
  test('another teacher cannot see, change or mark an exam of a section that is not theirs', async () => {
    expect((await other.get(`/examinations/${ids.t1}`)).status).toBe(403);
    expect((await other.get(`/examinations/${ids.t1}/sheet`)).status).toBe(403);
    expect((await marks(other, ids.t1!, [{ k: 'amina', v: 0, marks: 1 }])).status).toBe(403);
    expect((await other.patch(`/examinations/${ids.t1}`, { name: 'Hijacked' })).status).toBe(403);
    expect((await other.del(`/examinations/${ids.odd}`)).status).toBe(403);
    expect((await other.get(`/examinations?academicYearId=${year1}&sectionId=${S.B}`)).status).toBe(403);
    expect((await other.get(`/examinations/${ids.t1c}`)).status).toBe(200); // their own section's exam is fine
  });
});

describe('academic years: history is never lost', () => {
  test('closing a year (by activating the next) locks it: changes need a correction reason; no new data', async () => {
    const act = await teacher.post(`/academic-years/${year2}/activate`);
    expect(act.status).toBe(200);
    const years = (await teacher.get('/academic-years')).body;
    expect(years.find((y: any) => y.id === year1).status).toBe('closed');
    expect(years.find((y: any) => y.id === year2).status).toBe('active');

    const s = await sheet(1);
    expect(s.locked).toBe(true);
    const blocked = await save(teacher, E.brian!, row(s, 'brian').version, 1, { classActivities: 6 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('RECORD_LOCKED');
    const ok = await save(teacher, E.brian!, row(s, 'brian').version, 1, { classActivities: 6 }, { correctionReason: 'Late re-mark of Term 1 work' });
    expect(ok.status).toBe(200);

    const exam = await teacher.post('/examinations', { academicYearId: year1, sectionId: S.B, term: 1, name: 'Late exam', maxMarks: 10 });
    expect(exam.body.error.code).toBe('ACADEMIC_YEAR_CLOSED');
    const stu = await teacher.post('/students', { academicYearId: year1, sectionId: S.B, studentId: 'LATE-1', fullName: 'Late Joiner' });
    expect(stu.body.error.code).toBe('ACADEMIC_YEAR_CLOSED');
  });
  test('the previous year\'s records are all still there', async () => {
    const summary = (await teacher.get(`/academic-years/${year1}/summary`)).body;
    expect(summary.sections.find((s: any) => s.label === '1B')).toMatchObject({ students: 3, examinations: 3 });
    expect((await t.ds.query(`SELECT count(*)::int AS n FROM exam_marks`))[0].n).toBeGreaterThan(0);
  });
  test('the same student can be enrolled in the new year (possibly another section) without touching old data', async () => {
    const r = await teacher.post('/students', { academicYearId: year2, sectionId: S.D, studentId: 'T-1001', fullName: 'Amina Ali' });
    expect(r.status).toBe(201);
    expect(r.body.existingStudent).toBe(true);
    expect(row(await sheet(1), 'amina').state).toBe('entered'); // 2026/2027 untouched
  });
  test('only one academic year can be active, and years with records cannot be deleted (database level)', async () => {
    await expect(t.ds.query(`UPDATE academic_years SET status = 'active' WHERE id = $1`, [year1])).rejects.toThrow();
    await expect(t.ds.query(`DELETE FROM academic_years WHERE id = $1`, [year1])).rejects.toThrow();
    await expect(t.ds.query(`DELETE FROM students WHERE student_id = 'T-1001'`)).rejects.toThrow();
    await expect(t.ds.query(`UPDATE enrollments SET section_id = $2 WHERE id = $1`, [E.amina, S.C])).rejects.toThrow(/already has marks/);
  });
  test('malformed academic year labels are rejected', async () => {
    expect((await teacher.post('/academic-years', { label: '2028-2029' })).status).toBe(400);
    expect((await teacher.post('/academic-years', { label: '2028/2030' })).status).toBe(400);
    expect((await teacher.post('/academic-years', { label: '2026/2027' })).status).toBe(409);
  });
});
