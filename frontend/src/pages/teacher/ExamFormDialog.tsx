import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { FieldError } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, ApiError, errorMessage } from '@/lib/api';
import { TERM_LABELS, TERMS } from '@/lib/format';
import { invalidateResults } from '@/lib/queryClient';
import type { Examination, SectionRef, Term } from '@/lib/types';

// The maximum is whatever the teacher sets for this examination (50, 60, 100 ... are only examples); it is never hardcoded.
const schema = z.object({
  name: z.string().trim().min(1, 'Enter a name for the examination').max(120, 'Keep the name under 120 characters'),
  term: z.number(),
  maxMarks: z.number('Enter the maximum marks').positive('The maximum must be greater than 0').max(1000, 'The maximum cannot exceed 1000').refine((v) => Math.round(v * 100) / 100 === v, 'Use at most two decimal places'),
  examDate: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, 'Use a valid date'),
  sectionIds: z.array(z.string()),
});
type FormValues = z.infer<typeof schema>;

export function ExamFormDialog({ open, onOpenChange, yearId, sections, defaultSectionId, defaultTerm = 1, exam, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; yearId: string; sections: SectionRef[]; defaultSectionId?: string; defaultTerm?: Term; exam?: Examination; onSaved?: (created: Examination[]) => void }) {
  const editing = !!exam;
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', term: defaultTerm, maxMarks: undefined as unknown as number, examDate: '', sectionIds: defaultSectionId ? [defaultSectionId] : [] },
  });
  const { errors } = form.formState;

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    form.reset({ name: exam?.name ?? '', term: exam?.term ?? defaultTerm, maxMarks: exam?.maxMarks ?? (undefined as unknown as number), examDate: exam?.examDate ?? '', sectionIds: defaultSectionId ? [defaultSectionId] : [] });
  }, [open, exam, defaultSectionId, defaultTerm, form]);

  const mutation = useMutation({
    mutationFn: (v: FormValues) =>
      editing
        ? api.patch<Examination>(`/examinations/${exam!.id}`, { name: v.name, maxMarks: v.maxMarks, examDate: v.examDate || null }).then((r) => [r])
        : api.post<Examination[]>('/examinations', { academicYearId: yearId, sectionIds: v.sectionIds, term: v.term, name: v.name, maxMarks: v.maxMarks, examDate: v.examDate || null }),
    onSuccess: (result) => {
      toast.success(editing ? 'Examination updated.' : result.length > 1 ? `Created for ${result.length} sections.` : 'Examination created.');
      void invalidateResults();
      onSaved?.(result);
      onOpenChange(false);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fieldErrors.length) setFormError(e.fieldErrors.map((f) => f.message).join(' '));
      else setFormError(errorMessage(e));
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={form.handleSubmit((v) => {
            if (!editing && v.sectionIds.length === 0) {
              form.setError('sectionIds', { message: 'Select at least one section' });
              return;
            }
            setFormError(null);
            mutation.mutate(v);
          })}
        >
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit examination' : 'New examination'}</DialogTitle>
            <DialogDescription>
              {editing ? 'The maximum cannot be set below a mark that was already entered, and cannot change once marks are finalized.' : 'You decide the maximum marks. Percentages are always calculated from this maximum.'}
            </DialogDescription>
          </DialogHeader>

          <div>
            <Label htmlFor="exam-name" className="mb-1.5">Name</Label>
            <Input id="exam-name" autoFocus placeholder="For example: Term 1 Physics Examination" aria-invalid={!!errors.name} {...form.register('name')} />
            <FieldError>{errors.name?.message}</FieldError>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="mb-1.5">Term</Label>
              <Controller
                control={form.control}
                name="term"
                render={({ field }) => (
                  <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))} disabled={editing}>
                    <SelectTrigger className="w-full" aria-label="Term">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TERMS.map((t) => (
                        <SelectItem key={t} value={String(t)}>{TERM_LABELS[t]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div>
              <Label htmlFor="exam-max" className="mb-1.5">Maximum marks</Label>
              <Input id="exam-max" type="number" inputMode="decimal" step="any" min="0" placeholder="e.g. 60" aria-invalid={!!errors.maxMarks} {...form.register('maxMarks', { setValueAs: (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)) })} />
              <FieldError>{errors.maxMarks?.message}</FieldError>
            </div>
          </div>

          <div>
            <Label htmlFor="exam-date" className="mb-1.5">Date <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Input id="exam-date" type="date" {...form.register('examDate')} />
            <FieldError>{errors.examDate?.message}</FieldError>
          </div>

          {!editing && (
            <fieldset>
              <legend className="mb-1.5 text-[13px] leading-none font-medium">Sections taking this examination</legend>
              <Controller
                control={form.control}
                name="sectionIds"
                render={({ field }) => (
                  <div className="grid grid-cols-4 gap-1.5">
                    {sections.map((s) => {
                      const checked = field.value.includes(s.id);
                      return (
                        <label key={s.id} className="flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-[13px] hover:bg-accent has-[:checked]:border-primary/50 has-[:checked]:bg-accent">
                          <Checkbox checked={checked} onCheckedChange={(c) => field.onChange(c ? [...field.value, s.id] : field.value.filter((x) => x !== s.id))} />
                          {s.label}
                        </label>
                      );
                    })}
                  </div>
                )}
              />
              <FieldError>{errors.sectionIds?.message as string | undefined}</FieldError>
              <p className="mt-1.5 text-xs text-muted-foreground">One examination is created for each selected section, with its own marks.</p>
            </fieldset>
          )}

          {formError && <FieldError>{formError}</FieldError>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>Cancel</Button>
            <Button type="submit" loading={mutation.isPending}>{editing ? 'Save changes' : 'Create examination'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
