
import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import type { Relation } from 'typeorm';
import { numericTransformer } from '../common/decimal';
import { Enrollment } from '../students/enrollment.entity';
import { Teacher } from '../teachers/teacher.entity';

export type RecordStatus = 'entered' | 'finalized';

/**
 * One continuous-assessment record per student, academic year (via enrollment) and term.
 * NULL in a category means "not entered yet" - it is never treated as zero.
 */
@Entity('assessments')
@Unique(['enrollmentId', 'term'])
@Index('idx_assessments_enrollment', ['enrollmentId'])
@Check(`"term" BETWEEN 1 AND 3`)
@Check(`"monthly_exam_test_1" IS NULL OR ("monthly_exam_test_1" >= 0 AND "monthly_exam_test_1" <= 10)`)
@Check(`"quantity_of_heat_assignments" IS NULL OR ("quantity_of_heat_assignments" >= 0 AND "quantity_of_heat_assignments" <= 6)`)
@Check(`"electrostatics_assignments" IS NULL OR ("electrostatics_assignments" >= 0 AND "electrostatics_assignments" <= 5)`)
@Check(`"physics_notebook_assessments" IS NULL OR ("physics_notebook_assessments" >= 0 AND "physics_notebook_assessments" <= 5)`)
@Check(`"physics_textbook_assessments" IS NULL OR ("physics_textbook_assessments" >= 0 AND "physics_textbook_assessments" <= 5)`)
@Check(`"capacitors_notes_assessments" IS NULL OR ("capacitors_notes_assessments" >= 0 AND "capacitors_notes_assessments" <= 4)`)
@Check(`"properties_of_matter_assignment" IS NULL OR ("properties_of_matter_assignment" >= 0 AND "properties_of_matter_assignment" <= 5)`)
@Check(`"heat_and_temperature_assignment" IS NULL OR ("heat_and_temperature_assignment" >= 0 AND "heat_and_temperature_assignment" <= 5)`)
@Check(`"status" IN ('entered', 'finalized')`)
export class AssessmentRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'enrollment_id', type: 'uuid' })
  enrollmentId!: string;

  @ManyToOne(() => Enrollment, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'enrollment_id' })
  enrollment!: Relation<Enrollment>;

  @Column({ name: 'term', type: 'smallint' })
  term!: number;

  @Column({ name: 'monthly_exam_test_1', type: 'numeric', precision: 4, scale: 2, nullable: true, transformer: numericTransformer })
  monthlyExamTest1!: number | null;

  @Column({ name: 'quantity_of_heat_assignments', type: 'numeric', precision: 4, scale: 2, nullable: true, transformer: numericTransformer })
  quantityOfHeatAssignments!: number | null;

  @Column({ name: 'electrostatics_assignments', type: 'numeric', precision: 4, scale: 2, nullable: true, transformer: numericTransformer })
  electrostaticsAssignments!: number | null;

  @Column({ name: 'physics_notebook_assessments', type: 'numeric', precision: 4, scale: 2, nullable: true, transformer: numericTransformer })
  physicsNotebookAssessments!: number | null;

  @Column({ name: 'physics_textbook_assessments', type: 'numeric', precision: 4, scale: 2, nullable: true, transformer: numericTransformer })
  physicsTextbookAssessments!: number | null;

  @Column({ name: 'capacitors_notes_assessments', type: 'numeric', precision: 4, scale: 2, nullable: true, transformer: numericTransformer })
  capacitorsNotesAssessments!: number | null;

  @Column({ name: 'properties_of_matter_assignment', type: 'numeric', precision: 4, scale: 2, nullable: true, transformer: numericTransformer })
  propertiesOfMatterAssignment!: number | null;

  @Column({ name: 'heat_and_temperature_assignment', type: 'numeric', precision: 4, scale: 2, nullable: true, transformer: numericTransformer })
  heatAndTemperatureAssignment!: number | null;

  @Column({ name: 'status', type: 'varchar', length: 10, default: 'entered' })
  status!: RecordStatus;

  /** Optimistic-concurrency counter, incremented on every change. */
  @Column({ name: 'version', type: 'integer', default: 1 })
  version!: number;

  @Column({ name: 'updated_by_id', type: 'uuid', nullable: true })
  updatedById!: string | null;

  @ManyToOne(() => Teacher, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'updated_by_id' })
  updatedBy!: Relation<Teacher> | null;

  @Column({ name: 'finalized_at', type: 'timestamptz', nullable: true })
  finalizedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
