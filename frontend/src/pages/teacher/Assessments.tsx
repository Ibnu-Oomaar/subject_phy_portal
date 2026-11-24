import { useMutation, useQuery } from '@tanstack/react-query';

import { AlertTriangle, ClipboardList, Download, History, Lock, LockOpen, Save, Search, Undo2, Upload } from 'lucide-react';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { Link } from 'react-router-dom';

import { toast } from 'sonner';

import { Banner, ConfirmDialog, EmptyState, ErrorState, PageHeader, StateBadge, TableSkeleton } from '@/components/common';

import { CorrectionDialog } from '@/components/CorrectionDialog';

import { HistorySheet } from '@/components/HistoryPanel';

import { Badge } from '@/components/ui/badge';

import { Button } from '@/components/ui/button';

import { Card } from '@/components/ui/card';

import { Input } from '@/components/ui/input';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { useWorkspace } from '@/hooks/useWorkspace';

import { api, ApiError, errorMessage } from '@/lib/api';

import { fmtMarks, fmtPercent, markProblem, plural, TERM_LABELS, TERMS } from '@/lib/format';

import { applyEdit, buildEntries, cellText, countProblems, liveTotals, type Bases, type Drafts } from '@/lib/grid';

import { invalidateResults } from '@/lib/queryClient';

import type { AssessmentField, AssessmentSheet, AssessmentSheetRow, FinalizeResult, ResultState, SaveResult, Term } from '@/lib/types';

import { cn } from '@/lib/utils';



type Filter = 'all' | ResultState;

interface Pending {

  drafts: Drafts;

  bases: Bases;

}

const EMPTY: Pending = { drafts: {}, bases: {} };



export default function Assessments() {

  const { yearId, sectionId, year, section } = useWorkspace();

  const [term, setTerm] = useState<Term>(1);

  const [filter, setFilter] = useState<Filter>('all');

  const [search, setSearch] = useState('');

  // Unsaved entries are kept per year/section/term, so switching tabs never loses typing.

  const [pending, setPending] = useState<Record<string, Pending>>({});

  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});

  const [correctionMode, setCorrectionMode] = useState(false);

  const [reasonOpen, setReasonOpen] = useState(false);

  const [finalizeOpen, setFinalizeOpen] = useState(false);

  const [historyFor, setHistoryFor] = useState<AssessmentSheetRow | null>(null);

  const tableRef = useRef<HTMLTableElement>(null);



  const key = `${yearId}:${sectionId}:${term}`;

  const { drafts, bases } = pending[key] ?? EMPTY;



  const sheetQuery = useQuery({

    queryKey: ['assessments', 'sheet', yearId, sectionId, term],

    queryFn: () => api.get<AssessmentSheet>('/assessments/sheet', { academicYearId: yearId, sectionId, term }),

    enabled: !!yearId && !!sectionId,

  });

  const sheet = sheetQuery.data;



  useEffect(() => setCorrectionMode(false), [key]);

  useEffect(() => setServerErrors({}), [key]);



  const dirtyIds = Object.keys(drafts);

  const totalUnsaved = Object.values(pending).reduce((n, p) => n + Object.keys(p.drafts).length, 0);

  useEffect(() => {

    if (!totalUnsaved) return;

    const warn = (e: BeforeUnloadEvent) => e.preventDefault();

    window.addEventListener('beforeunload', warn);

    return () => window.removeEventListener('beforeunload', warn);

  }, [totalUnsaved]);



  const setCell = useCallback(

    (row: AssessmentSheetRow, field: AssessmentField, text: string) => {

      setServerErrors((e) => (e[`${row.enrollmentId}:${field}`] ? { ...e, [`${row.enrollmentId}:${field}`]: '' } : e));

      setPending((all) => {

        const cur = all[key] ?? EMPTY;

        const nextDraft = applyEdit(cur.drafts[row.enrollmentId], field, text, row.scores[field]);

        const nextDrafts = { ...cur.drafts };

        const nextBases = { ...cur.bases };

        if (nextDraft) {

          nextDrafts[row.enrollmentId] = nextDraft;

          nextBases[row.enrollmentId] ??= row.version; // remember which version this edit was based on

        } else {

          delete nextDrafts[row.enrollmentId];

          delete nextBases[row.enrollmentId];

        }

        return { ...all, [key]: { drafts: nextDrafts, bases: nextBases } };

      });

    },

    [key],

  );

  const clearRows = (ids: string[]) =>

    setPending((all) => {

      const cur = all[key] ?? EMPTY;

      const d = { ...cur.drafts };

      const b = { ...cur.bases };

      for (const id of ids) {

        delete d[id];

        delete b[id];

      }

      return { ...all, [key]: { drafts: d, bases: b } };

    });

  /** Someone else changed a record while you were typing: keep your values on top of their version, or drop yours. */

  const rebase = (rows: AssessmentSheetRow[]) =>

    setPending((all) => {

      const cur = all[key] ?? EMPTY;

      const b = { ...cur.bases };

      for (const r of rows) b[r.enrollmentId] = r.version;

      return { ...all, [key]: { ...cur, bases: b } };

    });



  const staleRows = useMemo(() => (sheet ? sheet.rows.filter((r) => bases[r.enrollmentId] !== undefined && bases[r.enrollmentId] !== r.version) : []), [sheet, bases]);

  const problems = sheet ? countProblems(drafts, sheet.categories) : 0;



  const save = useMutation({

    mutationFn: (reason?: string) =>

      api.put<SaveResult>('/assessments/marks', { academicYearId: yearId, sectionId, term, correctionReason: reason, entries: buildEntries(drafts, bases) }),

    onSuccess: (res) => {

      clearRows(dirtyIds);

      setReasonOpen(false);

      setServerErrors({});

      const parts = [res.created && `${res.created} new`, res.updated && `${res.updated} updated`, res.corrected && `${res.corrected} corrected`].filter(Boolean);

      toast.success(parts.length ? `Saved: ${parts.join(', ')}.` : 'Nothing had changed.');

      void invalidateResults();

    },

    onError: (e) => {

      setReasonOpen(false);

      if (e instanceof ApiError && e.code === 'CONCURRENT_MODIFICATION') {

        toast.error('Some marks were changed by someone else', { description: 'Review the highlighted rows, then keep your values or use the latest ones.' });

        void sheetQuery.refetch();

      } else if (e instanceof ApiError && e.code === 'RECORD_LOCKED') {

        setReasonOpen(true);

      } else if (e instanceof ApiError && e.fieldErrors.length) {

        const next: Record<string, string> = {};

        for (const fe of e.fieldErrors) {

          const m = /^entries\.(\d+)\.(\w+)$/.exec(fe.path);

          const id = m ? Object.keys(drafts)[Number(m[1])] : undefined;

          if (m && id) next[`${id}:${m[2]}`] = fe.message;

        }

        setServerErrors(next);

        toast.error('Some entries are not valid', { description: e.fieldErrors[0]?.message });

      } else {

        toast.error('Could not save', { description: errorMessage(e) });

      }

    },

  });



  const finalize = useMutation({

    mutationFn: () => api.post<FinalizeResult>('/assessments/finalize', { academicYearId: yearId, sectionId, term }),

    onSuccess: (r) => {

      setFinalizeOpen(false);

      toast.success(`Finalized ${plural(r.finalized, 'result')}.`, {

        description: [r.incomplete && `${plural(r.incomplete, 'incomplete record')} left open`, r.missing && `${r.missing} with no marks left open`].filter(Boolean).join(' · ') || undefined,

      });

      void invalidateResults();

    },

    onError: (e) => {

      setFinalizeOpen(false);

      toast.error('Could not finalize', { description: errorMessage(e) });

    },

  });



  const rows = useMemo(() => {

    if (!sheet) return [];

    const q = search.trim().toLowerCase();

    return sheet.rows.filter((r) => (filter === 'all' || r.state === filter) && (!q || r.fullName.toLowerCase().includes(q) || r.studentId.toLowerCase().includes(q)));

  }, [sheet, filter, search]);



  const needsReason = !!sheet && (sheet.locked || dirtyIds.some((id) => sheet.rows.find((r) => r.enrollmentId === id)?.state === 'finalized'));

  const requestSave = () => {

    if (problems) {

      toast.error(`Fix ${plural(problems, 'entry', 'entries')} marked in red before saving.`);

      return;

    }

    if (needsReason) setReasonOpen(true);

    else save.mutate(undefined);

  };



  const onKey = (e: KeyboardEvent<HTMLInputElement>, r: number, c: number) => {

    const move = e.key === 'Enter' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;

    if (!move) return;

    e.preventDefault();

    tableRef.current?.querySelector<HTMLInputElement>(`input[data-r="${r + move}"][data-c="${c}"]:not(:disabled)`)?.focus();

  };



  if (!yearId || !sectionId) return <EmptyState icon={ClipboardList} title="Create an academic year first" description="Assessments are recorded per academic year." action={<Button asChild><Link to="/academic-years">Academic years</Link></Button>} />;



  const termDirty = (t: Term) => Object.keys(pending[`${yearId}:${sectionId}:${t}`]?.drafts ?? {}).length;

  const filters: Array<{ value: Filter; label: string; count?: number }> = [

    { value: 'all', label: 'All', count: sheet?.summary.students },

    { value: 'missing', label: 'Missing', count: sheet?.summary.missing },

    { value: 'partial', label: 'Partial', count: sheet?.summary.partial },

    { value: 'entered', label: 'Entered', count: sheet?.summary.entered },

    { value: 'finalized', label: 'Finalized', count: sheet?.summary.finalized },

  ];



  return (

    <div className="pb-20">

      <PageHeader

        title="Continuous assessment"

        description={`Class ${section?.label} · ${year?.label}. ${sheet?.categories.length ?? 0} assessment categories, ${sheet?.maxTotal ?? 30} marks in total. Leave a cell empty if the mark has not been entered yet; empty never counts as zero.`}

        actions={

          <>

            <Button variant="outline" size="sm" onClick={() => void api.download('/exports/assessments', { academicYearId: yearId, sectionId, term }).then((n) => toast.success(`Downloaded ${n}`)).catch((e) => toast.error(errorMessage(e)))}>

              <Download /> Export

            </Button>

            <Button size="sm" variant="outline" disabled={!sheet || dirtyIds.length > 0 || !sheet.summary.entered} onClick={() => setFinalizeOpen(true)}>

              <Lock /> Finalize term

            </Button>

          </>

        }

      />



      <Tabs value={String(term)} onValueChange={(v) => setTerm(Number(v) as Term)}>

        <TabsList>

          {TERMS.map((t) => (

            <TabsTrigger key={t} value={String(t)}>

              {TERM_LABELS[t]}

              {termDirty(t) > 0 && <span className="size-1.5 rounded-full bg-state-partial" title="Unsaved entries" />}

            </TabsTrigger>

          ))}

        </TabsList>

      </Tabs>



      <div className="mt-3 flex flex-wrap items-center gap-2">

        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by status">

          {filters.map((f) => (

            <Button key={f.value} size="sm" variant={filter === f.value ? 'secondary' : 'ghost'} aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>

              {f.label}

              {f.count !== undefined && <span className="tabular text-muted-foreground">{f.count}</span>}

            </Button>

          ))}

        </div>

        <div className="relative ml-auto w-full sm:w-60">

          <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />

          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or ID" className="pl-8" aria-label="Search students" />

        </div>

      </div>



      {sheet?.locked && (

        <div className="mt-3">

          <Banner tone="warning" icon={Lock}>

            <strong>{sheet.academicYear.label} is closed.</strong> Marks are read-only. To correct one, turn on corrections and give a reason; every change is recorded.

          </Banner>

        </div>

      )}

      {staleRows.length > 0 && (

        <div className="mt-3">

          <Banner tone="warning" icon={AlertTriangle}>

            <p>

              <strong>{plural(staleRows.length, 'record')}</strong> {staleRows.length === 1 ? 'was' : 'were'} changed by someone else while you were editing ({staleRows.slice(0, 3).map((r) => r.fullName).join(', ')}

              {staleRows.length > 3 ? '…' : ''}).

            </p>

            <div className="mt-2 flex gap-2">

              <Button size="sm" variant="outline" onClick={() => rebase(staleRows)}>Keep my values</Button>

              <Button size="sm" variant="outline" onClick={() => clearRows(staleRows.map((r) => r.enrollmentId))}>Use the latest values</Button>

            </div>

          </Banner>

        </div>

      )}



      <Card className="mt-3 overflow-hidden p-0">

        {sheetQuery.isPending ? (

          <TableSkeleton rows={8} cols={8} />

        ) : sheetQuery.isError ? (

          <div className="p-4"><ErrorState error={sheetQuery.error} onRetry={() => void sheetQuery.refetch()} /></div>

        ) : !sheet ? null : sheet.rows.length === 0 ? (

          <div className="p-4">

            <EmptyState icon={ClipboardList} title={`No students in Class ${section?.label}`} description={`There are no students enrolled in ${year?.label} for this section yet.`} action={<Button asChild><Link to="/import"><Upload /> Import students</Link></Button>} />

          </div>

        ) : (

          <div className="relative overflow-x-auto">

            <table ref={tableRef} className="w-full min-w-[820px] text-[13px]">

              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">

                <tr>

                  <th className="w-24 px-3 py-2 text-left font-medium">Student ID</th>

                  <th className="sticky left-0 z-10 min-w-44 bg-muted px-3 py-2 text-left font-medium">Student</th>

                  {sheet.categories.map((c) => (

                    <th key={c.code} className="w-[104px] px-2 py-2 text-center font-medium">

                      <span className="block leading-tight">{c.name}</span>

                      <span className="tabular text-[11px] font-normal">out of {c.maxMarks}</span>

                    </th>

                  ))}

                  <th className="w-20 px-2 py-2 text-right font-medium">Total /{sheet.maxTotal}</th>

                  <th className="w-16 px-2 py-2 text-right font-medium">%</th>

                  <th className="w-28 px-3 py-2 text-left font-medium">Status</th>

                  <th className="w-10 px-2 py-2"><span className="sr-only">History</span></th>

                </tr>

              </thead>

              <tbody>

                {rows.length === 0 && (

                  <tr><td colSpan={sheet.categories.length + 6} className="px-3 py-10 text-center text-muted-foreground">No students match this filter.</td></tr>

                )}

                {rows.map((row, r) => {

                  const draft = drafts[row.enrollmentId];

                  const live = liveTotals(row, draft, sheet.categories, sheet.maxTotal);

                  const dirty = !!draft;

                  const editable = !(row.state === 'finalized' || sheet.locked) || correctionMode;

                  const stale = staleRows.some((s) => s.enrollmentId === row.enrollmentId);

                  const total = dirty ? live.total : row.total;

                  const percent = dirty ? live.percent : row.percent;

                  return (

                    <tr key={row.enrollmentId} className={cn('border-b last:border-0 hover:bg-muted/30', dirty && 'bg-state-partial/5', stale && 'bg-destructive/5')}>

                      <td className="tabular px-3 py-1.5 text-muted-foreground">{row.studentId}</td>

                      <td className="sticky left-0 z-10 bg-card px-3 py-1.5 font-medium">{row.fullName}</td>

                      {sheet.categories.map((c, ci) => {

                        const text = cellText(row, c.field, draft);

                        const problem = markProblem(text, c.maxMarks) ?? (serverErrors[`${row.enrollmentId}:${c.field}`] || null);

                        return (

                          <td key={c.code} className="px-2 py-1">

                            <Tooltip open={problem ? undefined : false}>

                              <TooltipTrigger asChild>

                                <input

                                  data-r={r}

                                  data-c={ci}

                                  inputMode="decimal"

                                  autoComplete="off"

                                  disabled={!editable}

                                  value={text}

                                  aria-label={`${row.fullName}: ${c.name}, out of ${c.maxMarks}`}

                                  aria-invalid={!!problem}

                                  onFocus={(e) => e.currentTarget.select()}

                                  onChange={(e) => setCell(row, c.field, e.target.value)}

                                  onKeyDown={(e) => onKey(e, r, ci)}

                                  className={cn(

                                    'tabular h-8 w-full rounded-md border bg-card px-1 text-center outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-primary/60 focus:ring-[3px] focus:ring-ring disabled:cursor-not-allowed disabled:bg-muted/40 disabled:text-muted-foreground',

                                    problem ? 'border-destructive bg-destructive/5 focus:ring-destructive/20' : draft?.[c.field] !== undefined ? 'border-state-partial/70 bg-state-partial/10' : 'border-input',

                                  )}

                                  placeholder="–"

                                />

                              </TooltipTrigger>

                              <TooltipContent>{problem}</TooltipContent>

                            </Tooltip>

                          </td>

                        );

                      })}

                      <td className={cn('tabular px-2 py-1.5 text-right font-medium', (row.state === 'partial' || (dirty && live.percent === null)) && 'text-muted-foreground italic')} title={percent === null && total !== null ? 'Provisional: the assessment is not complete' : undefined}>

                        {fmtMarks(total)}

                      </td>

                      <td className="tabular px-2 py-1.5 text-right text-muted-foreground">{fmtPercent(percent)}</td>

                      <td className="px-3 py-1.5">

                        <div className="flex items-center gap-1.5">

                          <StateBadge state={row.state} />

                          {dirty && <span className="size-1.5 rounded-full bg-state-partial" title="Unsaved changes" />}

                        </div>

                      </td>

                      <td className="px-2 py-1.5">

                        <Button variant="ghost" size="icon-sm" aria-label={`Change history for ${row.fullName}`} onClick={() => setHistoryFor(row)} disabled={row.version === 0}>

                          <History />

                        </Button>

                      </td>

                    </tr>

                  );

                })}

              </tbody>

            </table>

          </div>

        )}

      </Card>



      {sheet && sheet.rows.length > 0 && (sheet.summary.finalized > 0 || sheet.locked) && (

        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">

          <Button variant={correctionMode ? 'secondary' : 'ghost'} size="sm" onClick={() => setCorrectionMode((v) => !v)} aria-pressed={correctionMode}>

            {correctionMode ? <LockOpen /> : <Lock />} {correctionMode ? 'Corrections on' : 'Correct finalized marks'}

          </Button>

          <span>Finalized results are locked. Corrections need a reason and are kept in the history.</span>

        </div>

      )}



      {dirtyIds.length > 0 && (

        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-popover/95 px-4 py-2.5 backdrop-blur md:left-[13.5rem]" role="region" aria-label="Unsaved changes">

          <div className="mx-auto flex max-w-[1200px] items-center gap-3">

            <Badge variant="warning">{plural(dirtyIds.length, 'student')} changed</Badge>

            {problems > 0 && <span className="text-xs text-destructive">{plural(problems, 'entry', 'entries')} need attention</span>}

            <div className="ml-auto flex gap-2">

              <Button variant="ghost" size="sm" disabled={save.isPending} onClick={() => clearRows(dirtyIds)}>

                <Undo2 /> Discard

              </Button>

              <Button size="sm" loading={save.isPending} onClick={requestSave}>

                <Save /> Save changes

              </Button>

            </div>

          </div>

        </div>

      )}



      <CorrectionDialog open={reasonOpen} onOpenChange={setReasonOpen} count={dirtyIds.length} loading={save.isPending} onSubmit={(reason) => save.mutate(reason)} />

      <ConfirmDialog

        open={finalizeOpen}

        onOpenChange={setFinalizeOpen}

        loading={finalize.isPending}

        title={`Finalize ${TERM_LABELS[term]} assessments?`}

        confirmLabel="Finalize"

        onConfirm={() => finalize.mutate()}

        description={

          <p>

            {sheet ? `${plural(sheet.summary.entered, 'complete assessment')} in Class ${section?.label} will be locked.` : ''} Incomplete and missing records stay open. Changing a finalized mark later needs a written reason and is kept in the history.

          </p>

        }

      />

      <HistorySheet

        open={!!historyFor}

        onOpenChange={(o) => !o && setHistoryFor(null)}

        title={historyFor?.fullName ?? ''}

        description={`${TERM_LABELS[term]} assessment history · ${historyFor?.studentId ?? ''}`}

        queryKey={['assessments', 'history', yearId, sectionId, term, historyFor?.enrollmentId]}

        path="/assessments/history"

        query={{ academicYearId: yearId, sectionId, term: String(term), enrollmentId: historyFor?.enrollmentId ?? '' }}

      />

    </div>

  );

}