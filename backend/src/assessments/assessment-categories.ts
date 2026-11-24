
/**
 * Assessment categories are defined separately for each class.
 * Class 2 and Class 3 have different categories.
 */
export const ASSESSMENT_CATEGORIES_BY_CLASS = {
  2: [
    { code: 'monthly_exam_test_1', field: 'monthlyExamTest1', name: 'Monthly Examination – Test 1', maxMarks: 10, sortOrder: 1 },
    { code: 'properties_of_matter_assignment', field: 'propertiesOfMatterAssignment', name: 'Properties of Matter – Assignment', maxMarks: 5, sortOrder: 2 },
    { code: 'heat_and_temperature_assignment', field: 'heatAndTemperatureAssignment', name: 'Heat and Temperature – Assignment', maxMarks: 5, sortOrder: 3 },
    { code: 'physics_notebook_assessments', field: 'physicsNotebookAssessments', name: 'Physics Notebook Assessment', maxMarks: 5, sortOrder: 4 },
    { code: 'physics_textbook_assessments', field: 'physicsTextbookAssessments', name: 'Physics Textbook Assessment', maxMarks: 5, sortOrder: 5 },
  ],
  3: [
    { code: 'monthly_exam_test_1', field: 'monthlyExamTest1', name: 'Monthly Examination – Test 1', maxMarks: 5, sortOrder: 1 },
    { code: 'quantity_of_heat_assignments', field: 'quantityOfHeatAssignments', name: 'Quantity of Heat – Assignments', maxMarks: 6, sortOrder: 2 },
    { code: 'electrostatics_assignments', field: 'electrostaticsAssignments', name: 'Electrostatics – Assignments', maxMarks: 5, sortOrder: 3 },
    { code: 'physics_notebook_assessments', field: 'physicsNotebookAssessments', name: 'Physics Notebook Assessments', maxMarks: 5, sortOrder: 4 },
    { code: 'physics_textbook_assessments', field: 'physicsTextbookAssessments', name: 'Physics Textbook Assessments', maxMarks: 5, sortOrder: 5 },
    { code: 'capacitors_notes_assessments', field: 'capacitorsNotesAssessments', name: 'Capacitors Notes Assessments', maxMarks: 4, sortOrder: 6 },
  ],
} as const;

export type AssessmentClass = keyof typeof ASSESSMENT_CATEGORIES_BY_CLASS;

export type AssessmentField =
  | (typeof ASSESSMENT_CATEGORIES_BY_CLASS)[2][number]['field']
  | (typeof ASSESSMENT_CATEGORIES_BY_CLASS)[3][number]['field'];

export const getAssessmentCategories = (classId: number) => {
  if (classId !== 2 && classId !== 3) {
    throw new Error(`Assessment categories are not configured for class ${classId}`);
  }

  return ASSESSMENT_CATEGORIES_BY_CLASS[classId];
};

export const getAssessmentFields = (classId: number): readonly AssessmentField[] =>
  getAssessmentCategories(classId).map((category) => category.field);

export const getAssessmentMaxTotal = (classId: number): number =>
  getAssessmentCategories(classId).reduce((sum, category) => sum + category.maxMarks, 0);

export const getAssessmentMaxByField = (classId: number) =>
  Object.fromEntries(
    getAssessmentCategories(classId).map((category) => [category.field, category.maxMarks]),
  );
