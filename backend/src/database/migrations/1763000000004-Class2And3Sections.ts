import type { MigrationInterface, QueryRunner } from 'typeorm';

const CLASS_SECTIONS: Array<[number, string]> = [
  [2, 'B'],
  [2, 'C'],
  [2, 'D'],
  [2, 'E'],
  [3, 'A'],
  [3, 'B'],
  [3, 'C'],
  [3, 'D'],
  [3, 'E'],
];

export class Class2And3Sections1763000000004 implements MigrationInterface {
  name = 'Class2And3Sections1763000000004';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO classes (grade_level, name)
      VALUES (2, 'Class 2'), (3, 'Class 3')
      ON CONFLICT (grade_level) DO NOTHING
    `);
    await queryRunner.query(
      `INSERT INTO sections (class_id, code, label)
       SELECT c.id, s.code, c.grade_level::text || s.code
       FROM (VALUES ${CLASS_SECTIONS.map(([grade, section]) => `(${grade}, '${section}')`).join(', ')}) AS s(grade, code)
       JOIN classes c ON c.grade_level = s.grade
       ON CONFLICT (label) DO NOTHING`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const labels = CLASS_SECTIONS.map(([grade, section]) => `${grade}${section}`);
    await queryRunner.query(`DELETE FROM sections WHERE label = ANY($1::text[])`, [labels]);
    await queryRunner.query(`DELETE FROM classes WHERE grade_level = ANY($1::smallint[])`, [[2, 3]]);
  }
}
