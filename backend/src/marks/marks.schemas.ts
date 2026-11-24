
import { z } from 'zod';
import { hasAtMostTwoDecimals } from '../common/decimal';
import { termSchema, uuidSchema } from '../common/schemas';

const twoDecimals = (v: number) => hasAtMostTwoDecimals(v);

/** undefined = leave unchanged · null = clear the value · number = set it (0 is a real mark). */
const assessmentMark = z
  .number('Enter a number')
  .finite()
  .min(0, 'Marks cannot be negative')
  .refine(twoDecimals, 'Use at most two decimal places')
  .nullable()
  .optional();

const optionalReason = z
  .string()
  .max(500, 'Keep the reason under 500 characters')
  .optional()
  .transform((v) => v?.trim().replace(/\s+/g, ' ') || undefined);

const noDuplicateEnrollments = (entries: Array<{ enrollmentId: string }>, ctx: z.RefinementCtx) => {
  const seen = new Set<string>();
  entries.forEach((e, i) => {
    if (seen.has(e.enrollmentId)) {
      ctx.addIssue({ code: 'custom', path: [i, 'enrollmentId'], message: 'This student appears more than once' });
    }
    seen.add(e.enrollmentId);
  });
};

export const assessmentSaveSchema = z.object({
  academicYearId: uuidSchema,
  sectionId: uuidSchema,
  term: termSchema,
  /** Required to change a finalized record or anything in a closed academic year. */
  correctionReason: optionalReason,
  entries: z
    .array(
      z.object({
        enrollmentId: uuidSchema,
        /** The version the client loaded (0 when the student had no record yet). */
        version: z.number().int().min(0),
        monthlyExamTest1: assessmentMark,
        quantityOfHeatAssignments: assessmentMark,
        electrostaticsAssignments: assessmentMark,
        physicsNotebookAssessments: assessmentMark,
        physicsTextbookAssessments: assessmentMark,
        capacitorsNotesAssessments: assessmentMark,
        propertiesOfMatterAssignment: assessmentMark,
        heatAndTemperatureAssignment: assessmentMark,
      }),
    )
    .min(1, 'Nothing to save')
    .max(500)
    .superRefine(noDuplicateEnrollments),
});
export type AssessmentSaveDto = z.infer<typeof assessmentSaveSchema>;

export const examMarksSaveSchema = z.object({
  correctionReason: optionalReason,
  entries: z
    .array(
      z.object({
        enrollmentId: uuidSchema,
        version: z.number().int().min(0),
        /** null clears a mark that has not been finalized. The maximum is checked against the examination. */
        marks: z.number('Enter a number').finite().min(0, 'Marks cannot be negative').refine(twoDecimals, 'Use at most two decimal places').nullable(),
      }),
    )
    .min(1, 'Nothing to save')
    .max(500)
    .superRefine(noDuplicateEnrollments),
});
export type ExamMarksSaveDto = z.infer<typeof examMarksSaveSchema>;

export const finalizeAssessmentsSchema = z.object({ academicYearId: uuidSchema, sectionId: uuidSchema, term: termSchema });
export type FinalizeAssessmentsDto = z.infer<typeof finalizeAssessmentsSchema>;
