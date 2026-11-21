const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });
const DIR = OUT; // screenshots, downloads and results.json go here (git-ignored)
const FIXTURES = __dirname;
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:5173';
const TEACHER = process.env.E2E_TEACHER || 'Ms E2E Teacher';
const results = [];
let examUrl = '/examinations', profileUrl = '/students';
const consoleErrors = [];
const badResponses = [];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + e.message.slice(0, 300)));
  page.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/')) badResponses.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`); });

  const step = async (name, fn) => {
    try { await fn(); results.push(['PASS', name]); console.log('PASS', name); }
    catch (e) {
      results.push(['FAIL', name, e.message.split('\n')[0]]); console.log('FAIL', name, '-', e.message.split('\n')[0]);
      await page.screenshot({ path: path.join(DIR, 'fail-' + results.length + '.png') }).catch(() => {});
    }
  };
  const expectText = async (loc, re, ms = 6000) => { await loc.first().waitFor({ timeout: ms }); const t = await loc.first().innerText(); if (!re.test(t)) throw new Error(`text ${JSON.stringify(t)} !~ ${re}`); };
  const noErrorState = async (name) => { const n = await page.getByText('Something went wrong').count(); if (n) throw new Error(name + ' shows an error state'); };
  const cell = (who, cat) => page.getByLabel(new RegExp(`${who}: ${cat}`));

  await step('unauthenticated visit redirects to /login', async () => {
    await page.goto(BASE + '/'); await page.waitForURL(/\/login/);
    await page.screenshot({ path: path.join(DIR, '01-login.png') });
  });
  await step('wrong teacher name is rejected with a message, no session', async () => {
    await page.fill('#name', 'Nobody Here'); await page.getByRole('button', { name: 'Sign in as teacher' }).click();
    await page.getByText(/not recognised|incorrect|not found|could not|invalid/i).first().waitFor({ timeout: 5000 });
    if (!/\/login/.test(page.url())) throw new Error('left /login');
  });
  await step('teacher logs in by registered name only', async () => {
    await page.fill('#name', TEACHER); await page.getByRole('button', { name: 'Sign in as teacher' }).click();
    await page.waitForURL(BASE + '/', { timeout: 8000 });
    await page.getByText('Physics Portal').first().waitFor();
  });
  await step('dashboard with no academic year shows an empty state, not fake data', async () => {
    await page.waitForTimeout(800); await noErrorState('dashboard');
    await page.screenshot({ path: path.join(DIR, '02-dashboard-empty.png') });
  });
  await step('create academic year 2026/2027 (becomes active)', async () => {
    await page.goto(BASE + '/academic-years');
    await page.getByRole('button', { name: /New academic year/ }).first().click();
    await page.fill('#year-label', 'bad'); await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByText(/Use the format 2026\/2027/).waitFor();
    await page.fill('#year-label', '2026/2027'); await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByRole('cell', { name: '2026/2027' }).first().waitFor();
    await expectText(page.locator('tr', { hasText: '2026/2027' }), /Active/i);
    await page.screenshot({ path: path.join(DIR, '03-years.png') });
  });
  await step('duplicate academic year is refused', async () => {
    await page.getByRole('button', { name: /New academic year/ }).first().click();
    await page.fill('#year-label', '2026/2027'); await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByText(/already exists|duplicate/i).first().waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: 'Cancel' }).click();
  });
  await step('import: preview shows errors, nothing saved until confirmed', async () => {
    await page.goto(BASE + '/import');
    await page.setInputFiles('input[type=file]', path.join(FIXTURES, 'students.csv'));
    await page.getByRole('button', { name: 'Preview import' }).click();
    await page.getByText('Will be imported').waitFor({ timeout: 8000 });
    const body = await page.locator('main').innerText();
    if (!/Rows in file\s*6/.test(body)) throw new Error('rows in file != 6: ' + body.slice(0, 200));
    if (!/Will be imported\s*3/.test(body)) throw new Error('importable != 3');
    if (!/Rows with errors\s*3/.test(body)) throw new Error('errors != 3 (both rows with the duplicated ID and the bad section)');
    await page.screenshot({ path: path.join(DIR, '04-import-preview.png') });
    const btn = page.getByRole('button', { name: /^Import 3 students$/ });
    if (!(await btn.isDisabled())) throw new Error('import should be blocked until errors are acknowledged');
  });
  await step('import: acknowledge skipping errors, confirm, complete', async () => {
    await page.locator('#skip-invalid').click();
    await page.getByRole('button', { name: /^Import 3 students$/ }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Import now' }).click();
    await page.getByText('Import complete').waitFor({ timeout: 8000 });
    await page.screenshot({ path: path.join(DIR, '05-import-done.png') });
  });
  await step('re-importing the same file creates no duplicates (all rows flagged)', async () => {
    await page.getByRole('button', { name: 'Import another file' }).click();
    await page.setInputFiles('input[type=file]', path.join(FIXTURES, 'students.csv'));
    await page.getByRole('button', { name: 'Preview import' }).click();
    await page.getByText('Will be imported').waitFor({ timeout: 8000 });
    const body = await page.locator('main').innerText();
    if (!/Will be imported\s*0/.test(body)) throw new Error('already-enrolled students should not be importable again');
  });
  await step('students list is per section (1B has 2, 1C has 1)', async () => {
    await page.goto(BASE + '/students');
    await page.getByText('Amina Ali').first().waitFor(); await page.getByText('Brian Otieno').first().waitFor();
    if (await page.getByText('Cynthia Mwangi').count()) throw new Error('1C student visible in 1B');
    await page.getByLabel('Class section').click(); await page.getByRole('option', { name: /1C/ }).click();
    await page.getByText('Cynthia Mwangi').first().waitFor();
    if (await page.getByText('Amina Ali').count()) throw new Error('1B student visible in 1C');
    await page.getByLabel('Class section').click(); await page.getByRole('option', { name: /1B/ }).click();
    await page.getByText('Amina Ali').first().waitFor();
  });
  await step('assessments: invalid cell flagged (max 9)', async () => {
    await page.goto(BASE + '/assessments'); await cell('Brian Otieno', 'Class Activities').waitFor();
    await cell('Brian Otieno', 'Class Activities').fill('10');
    if ((await cell('Brian Otieno', 'Class Activities').getAttribute('aria-invalid')) !== 'true') throw new Error('not flagged');
    await page.getByText(/need attention/).waitFor();
    await cell('Brian Otieno', 'Class Activities').fill('');
  });
  await step('assessments: enter 9/6/10/5 for Amina and a partial for Brian, save', async () => {
    await cell('Amina Ali', 'Class Activities').fill('9'); await cell('Amina Ali', 'Homeworks and Assignments').fill('6');
    await cell('Amina Ali', 'Learning Materials and Notebook').fill('10'); await cell('Amina Ali', 'Textbook').fill('5');
    await cell('Brian Otieno', 'Class Activities').fill('5'); await cell('Brian Otieno', 'Homeworks and Assignments').fill('3');
    await page.screenshot({ path: path.join(DIR, '06-assessments-dirty.png') });
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText(/^Saved/).first().waitFor({ timeout: 6000 });
  });
  await step('assessments: values persist after reload; totals computed; partial is not zero-filled', async () => {
    await page.reload(); await cell('Amina Ali', 'Textbook').waitFor();
    if ((await cell('Amina Ali', 'Class Activities').inputValue()) !== '9') throw new Error('CA not persisted');
    if ((await cell('Brian Otieno', 'Textbook').inputValue()) !== '') throw new Error('missing Textbook was filled in (zero-fill!)');
    await expectText(page.locator('tr', { hasText: 'Amina Ali' }), /30/);
    await expectText(page.locator('tr', { hasText: 'Brian Otieno' }), /Partial/i);
    await page.screenshot({ path: path.join(DIR, '07-assessments-saved.png') });
  });
  await step('assessments: two-tab conflict is detected, not silently overwritten', async () => {
    const b = await ctx.newPage();
    await b.goto(BASE + '/assessments'); await b.getByLabel(/Brian Otieno: Textbook/).waitFor();
    await cell('Brian Otieno', 'Textbook').fill('1'); // tab A starts editing (draft based on current version)
    await b.getByLabel(/Brian Otieno: Textbook/).fill('2'); await b.getByRole('button', { name: 'Save changes' }).click();
    await b.getByText(/^Saved/).first().waitFor({ timeout: 6000 });
    await page.getByText(/changed by someone else/).first().waitFor({ timeout: 8000 });
    await page.screenshot({ path: path.join(DIR, '08-conflict.png') });
    await page.getByRole('button', { name: 'Use the latest values' }).click();
    if ((await cell('Brian Otieno', 'Textbook').inputValue()) !== '2') throw new Error('latest value not shown');
    await b.close();
  });
  await step('assessments: finalize term locks the record; correction requires a reason', async () => {
    await page.getByRole('button', { name: /Finalize term/ }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Finalize', exact: true }).click();
    await page.getByText(/^Finalized/).first().waitFor({ timeout: 6000 });
    await page.waitForTimeout(500);
    if (!(await cell('Amina Ali', 'Textbook').isDisabled())) throw new Error('finalized cell still editable');
    await page.getByRole('button', { name: /Correct finalized marks/ }).click();
    await cell('Amina Ali', 'Textbook').fill('4');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByRole('dialog').getByLabel('Reason for the correction').fill('abc');
    await page.getByRole('button', { name: 'Save correction' }).click();
    await page.getByText(/at least|too short|reason/i).first().waitFor();
    await page.getByLabel('Reason for the correction').fill('E2E: transcription error');
    await page.getByRole('button', { name: 'Save correction' }).click();
    await page.getByText(/^Saved/).first().waitFor({ timeout: 6000 });
    await page.screenshot({ path: path.join(DIR, '09-corrected.png') });
  });
  await step('assessments: change history shows the correction reason', async () => {
    await page.reload(); await cell('Amina Ali', 'Textbook').waitFor();
    await page.getByRole('button', { name: 'Change history for Amina Ali' }).click();
    await page.getByText(/transcription error/).first().waitFor({ timeout: 5000 });
    await page.screenshot({ path: path.join(DIR, '10-history.png') });
    await page.keyboard.press('Escape');
  });
  await step('examinations: create with teacher-chosen maximum (50), enter marks, max enforced', async () => {
    await page.goto(BASE + '/examinations');
    await page.getByRole('button', { name: /New examination/ }).first().click();
    await page.fill('#exam-name', 'Term 1 Physics Examination'); await page.fill('#exam-max', '50');
    await page.getByRole('button', { name: 'Create examination' }).click();
    await page.waitForURL(/\/examinations\/[0-9a-f-]{36}/, { timeout: 8000 }); // creating an exam opens it
    await page.getByRole('heading', { name: 'Term 1 Physics Examination' }).waitFor();
    examUrl = page.url().replace(BASE, '');
    const m = page.getByLabel(/Amina Ali: marks out of 50/); await m.waitFor();
    await m.fill('51'); if ((await m.getAttribute('aria-invalid')) !== 'true') throw new Error('51/50 not flagged');
    await m.fill('41'); await page.getByLabel(/Brian Otieno: marks out of 50/).fill('0');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText(/^Saved/).first().waitFor({ timeout: 6000 });
    await page.reload(); await page.getByLabel(/Amina Ali: marks out of 50/).waitFor();
    if ((await page.getByLabel(/Amina Ali: marks out of 50/).inputValue()) !== '41') throw new Error('41 not persisted');
    if ((await page.getByLabel(/Brian Otieno: marks out of 50/).inputValue()) !== '0') throw new Error('a real 0 was not persisted as 0');
    await page.screenshot({ path: path.join(DIR, '11-exam.png') });
  });
  for (const [name, url] of [['dashboard', '/'], ['analytics', '/analytics'], ['rankings', '/rankings']]) {
    await step(`${name} renders from real data without errors`, async () => {
      await page.goto(BASE + url); await page.waitForTimeout(1200); await noErrorState(name);
      await page.screenshot({ path: path.join(DIR, `12-${name}.png`) });
    });
  }
  await step('student profile opens from the students list', async () => {
    await page.goto(BASE + '/students'); await page.getByText('Amina Ali').first().click();
    await page.waitForURL(/\/students\/.+/); profileUrl = page.url().replace(BASE, ''); await page.waitForTimeout(1000); await noErrorState('profile');
    await page.getByText(/Term 1/).first().waitFor();
    await page.screenshot({ path: path.join(DIR, '13-profile.png') });
  });
  await step('Excel export downloads a real .xlsx (students)', async () => {
    await page.goto(BASE + '/reports');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('heading', { name: 'Students', exact: true }).locator('xpath=../../..').getByRole('button', { name: /Download Excel/ }).click()]);
    const file = path.join(DIR, 'students-export.xlsx'); await dl.saveAs(file);
    const head = fs.readFileSync(file).subarray(0, 2).toString();
    if (head !== 'PK') throw new Error('not an xlsx (zip) file');
    results.push(['INFO', 'students export saved as ' + dl.suggestedFilename()]);
  });
  await step('Excel export downloads a real .xlsx (class performance)', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('heading', { name: 'Class performance' }).locator('xpath=../../..').getByRole('button', { name: /Download Excel/ }).click()]);
    await dl.saveAs(path.join(DIR, 'class-performance.xlsx'));
    results.push(['INFO', 'class performance saved as ' + dl.suggestedFilename()]);
  });
  await step('dark theme', async () => {
    await page.getByLabel('Change colour theme').click(); await page.getByRole('menuitem', { name: /Dark/i }).click();
    await page.waitForTimeout(300);
    if (!(await page.evaluate(() => document.documentElement.classList.contains('dark')))) throw new Error('dark class not applied');
    await page.goto(BASE + '/assessments'); await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(DIR, '14-dark-assessments.png') });
  });
  await step('mobile (390px and 360px): no page has horizontal page scroll', async () => {
    const bad = [];
    for (const w of [390, 360]) {
      await page.setViewportSize({ width: w, height: 800 });
      for (const url of ['/', '/assessments', '/examinations', examUrl, '/students', profileUrl, '/analytics', '/rankings', '/reports', '/academic-years', '/import']) {
        await page.goto(BASE + url); await page.waitForTimeout(700);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (over > 1) bad.push(`${w}px ${url.replace(/[0-9a-f-]{36}/, ':id')} +${over}px`);
      }
    }
    await page.goto(BASE + '/assessments'); await page.waitForTimeout(600); await page.screenshot({ path: path.join(DIR, '15-mobile-assessments.png') });
    await page.setViewportSize({ width: 1360, height: 860 });
    if (bad.length) throw new Error('horizontal overflow: ' + bad.join('; '));
  });
  await step('sign out returns to /login and the API refuses further use', async () => {
    await page.goto(BASE + '/'); await page.getByRole('button', { name: new RegExp(TEACHER.slice(0, 6)) }).click(); await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.waitForURL(/\/login/);
    const status = await page.evaluate(() => fetch('/api/students').then((r) => r.status));
    if (status !== 401) throw new Error('API answered ' + status + ' after logout');
  });
  await step('student logs in by ID only and sees read-only results; unknown ID is refused', async () => {
    await page.getByRole('tab', { name: 'Student' }).click();
    await page.fill('#studentId', 'NOPE-9999'); await page.getByRole('button', { name: 'View my results' }).click();
    await page.getByText(/not recognised|not found|could not|invalid|incorrect/i).first().waitFor({ timeout: 5000 });
    await page.fill('#studentId', 'e2e-1002'); await page.getByRole('button', { name: 'View my results' }).click();
    await page.waitForURL(/\/student/, { timeout: 8000 });
    await page.getByText('My results').first().waitFor(); await page.waitForTimeout(1000); await noErrorState('student dashboard');
    if (await page.locator('input').count()) throw new Error('student dashboard has inputs (should be read-only)');
    await page.screenshot({ path: path.join(DIR, '16-student.png') });
    await page.setViewportSize({ width: 390, height: 800 }); await page.waitForTimeout(300);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await page.screenshot({ path: path.join(DIR, '17-student-mobile.png') }); await page.setViewportSize({ width: 1360, height: 860 });
    if (over > 1) throw new Error('student dashboard overflows on mobile by ' + over + 'px');
  });
  await step('student cannot reach teacher pages or teacher APIs', async () => {
    await page.goto(BASE + '/assessments'); await page.waitForURL(/\/student/, { timeout: 5000 });
    const s = await page.evaluate(async () => [(await fetch('/api/students')).status, (await fetch('/api/assessments/sheet')).status]);
    if (!s.every((x) => x === 403)) throw new Error('teacher APIs answered ' + s.join(','));
  });

  await browser.close();
  const fails = results.filter((r) => r[0] === 'FAIL');
  console.log('\n==== SUMMARY ====');
  console.log(`${results.filter((r) => r[0] === 'PASS').length} passed, ${fails.length} failed`);
  results.filter((r) => r[0] === 'INFO').forEach((r) => console.log(r[1]));
  console.log('console errors:', JSON.stringify([...new Set(consoleErrors)], null, 1));
  console.log('HTTP >= 400 seen by the browser:', JSON.stringify([...new Set(badResponses)], null, 1));
  fs.writeFileSync(path.join(DIR, 'results.json'), JSON.stringify({ results, consoleErrors, badResponses }, null, 1));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('SCRIPT CRASH', e); process.exit(2); });
