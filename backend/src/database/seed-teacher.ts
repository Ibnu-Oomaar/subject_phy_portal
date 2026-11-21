/**
 * Creates the Physics teacher account (there is intentionally no public registration) and assigns every
 * section. Safe to run repeatedly: an existing teacher with the same name is left unchanged.
 *
 *   bun run seed:teacher -- --name "Full Name" [--passcode "at-least-8-chars"] [--sections 1B,1C]
 * or set SEED_TEACHER_NAME / SEED_TEACHER_PASSCODE in the environment.
 */
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { env } from '../config/env';
import { createDataSource } from './data-source';
import { Teacher } from '../teachers/teacher.entity';
import { TeacherSection } from '../teachers/teacher-section.entity';
import { Section } from '../sections/section.entity';
import { normalizeTeacherName } from '../teachers/teachers.service';

const { values } = parseArgs({
  args: Bun.argv.slice(2).filter((a) => a !== '--'),
  options: { name: { type: 'string' }, passcode: { type: 'string' }, sections: { type: 'string' } },
});
const name = (values.name ?? process.env.SEED_TEACHER_NAME ?? '').trim().replace(/\s+/g, ' ');
const passcode = values.passcode ?? process.env.SEED_TEACHER_PASSCODE;
if (!name) {
  console.error('A teacher name is required: bun run seed:teacher -- --name "Full Name"');
  process.exit(1);
}
if (passcode !== undefined && passcode.length < 8) {
  console.error('The passcode must be at least 8 characters.');
  process.exit(1);
}

const ds = createDataSource(env.DATABASE_URL);
await ds.initialize();
try {
  await ds.transaction(async (m) => {
    let teacher = await m.findOneBy(Teacher, { nameNormalized: normalizeTeacherName(name) });
    if (teacher) {
      console.log(`Teacher "${teacher.name}" already exists; keeping the existing account.`);
    } else {
      teacher = await m.save(
        Teacher,
        m.create(Teacher, {
          name,
          nameNormalized: normalizeTeacherName(name),
          passcodeHash: passcode ? await Bun.password.hash(passcode, 'argon2id') : null,
          isActive: true,
        }),
      );
      console.log(`Created teacher "${teacher.name}" ${passcode ? 'with a passcode' : 'WITHOUT a passcode (name-only login)'}.`);
    }
    const wanted = values.sections?.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    const sections = (await m.find(Section)).filter((s) => !wanted || wanted.includes(s.label));
    const have = new Set((await m.findBy(TeacherSection, { teacherId: teacher.id })).map((a) => a.sectionId));
    const missing = sections.filter((s) => !have.has(s.id));
    if (missing.length) {
      await m.save(TeacherSection, missing.map((s) => m.create(TeacherSection, { teacherId: teacher.id, sectionId: s.id })));
    }
    console.log(`Assigned sections: ${sections.map((s) => s.label).join(', ')}`);
  });
} finally {
  await ds.destroy();
}
