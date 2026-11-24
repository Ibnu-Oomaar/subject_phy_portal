
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAssessmentColumns1763000000005 implements MigrationInterface {
  name = 'AddAssessmentColumns1763000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assessments"
      ADD COLUMN "monthly_exam_test_1" numeric(4,2),
      ADD COLUMN "quantity_of_heat_assignments" numeric(4,2),
      ADD COLUMN "electrostatics_assignments" numeric(4,2),
      ADD COLUMN "physics_notebook_assessments" numeric(4,2),
      ADD COLUMN "physics_textbook_assessments" numeric(4,2),
      ADD COLUMN "capacitors_notes_assessments" numeric(4,2),
      ADD COLUMN "properties_of_matter_assignment" numeric(4,2),
      ADD COLUMN "heat_and_temperature_assignment" numeric(4,2);
    `);

    await queryRunner.query(`
      ALTER TABLE "assessments"
      ADD CONSTRAINT "CHK_assessments_monthly_exam_test_1"
        CHECK ("monthly_exam_test_1" IS NULL OR "monthly_exam_test_1" BETWEEN 0 AND 10),
      ADD CONSTRAINT "CHK_assessments_quantity_of_heat_assignments"
        CHECK ("quantity_of_heat_assignments" IS NULL OR "quantity_of_heat_assignments" BETWEEN 0 AND 6),
      ADD CONSTRAINT "CHK_assessments_electrostatics_assignments"
        CHECK ("electrostatics_assignments" IS NULL OR "electrostatics_assignments" BETWEEN 0 AND 5),
      ADD CONSTRAINT "CHK_assessments_physics_notebook_assessments"
        CHECK ("physics_notebook_assessments" IS NULL OR "physics_notebook_assessments" BETWEEN 0 AND 5),
      ADD CONSTRAINT "CHK_assessments_physics_textbook_assessments"
        CHECK ("physics_textbook_assessments" IS NULL OR "physics_textbook_assessments" BETWEEN 0 AND 5),
      ADD CONSTRAINT "CHK_assessments_capacitors_notes_assessments"
        CHECK ("capacitors_notes_assessments" IS NULL OR "capacitors_notes_assessments" BETWEEN 0 AND 4),
      ADD CONSTRAINT "CHK_assessments_properties_of_matter_assignment"
        CHECK ("properties_of_matter_assignment" IS NULL OR "properties_of_matter_assignment" BETWEEN 0 AND 5),
      ADD CONSTRAINT "CHK_assessments_heat_and_temperature_assignment"
        CHECK ("heat_and_temperature_assignment" IS NULL OR "heat_and_temperature_assignment" BETWEEN 0 AND 5);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assessments"
      DROP COLUMN "monthly_exam_test_1",
      DROP COLUMN "quantity_of_heat_assignments",
      DROP COLUMN "electrostatics_assignments",
      DROP COLUMN "physics_notebook_assessments",
      DROP COLUMN "physics_textbook_assessments",
      DROP COLUMN "capacitors_notes_assessments",
      DROP COLUMN "properties_of_matter_assignment",
      DROP COLUMN "heat_and_temperature_assignment";
    `);
  }
}
