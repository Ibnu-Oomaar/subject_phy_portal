import { BarChart3, CalendarDays, ClipboardList, FileSpreadsheet, FileText, LayoutDashboard, Menu, Radio, Trophy, Upload, Users, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { EmptyState, ErrorState, FullPageSpinner } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useRealtime } from '@/hooks/useRealtime';
import { useWorkspace, WorkspaceProvider } from '@/hooks/useWorkspace';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '@/theme/ThemeToggle';
import { UserMenu } from './UserMenu';

const NAV: Array<{ to: string; label: string; icon: LucideIcon; end?: boolean }> = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/assessments', label: 'Assessments', icon: ClipboardList },
  { to: '/examinations', label: 'Examinations', icon: FileText },
  { to: '/students', label: 'Students', icon: Users },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/rankings', label: 'Rankings', icon: Trophy },
  { to: '/reports', label: 'Reports', icon: FileSpreadsheet },
  { to: '/academic-years', label: 'Academic years', icon: CalendarDays },
  { to: '/import', label: 'Import students', icon: Upload },
];

function Brand() {
  return (
    <div className="flex h-12 items-center gap-2 px-4">
      <div className="flex size-6 items-center justify-center rounded-md bg-primary text-sm leading-none font-bold text-primary-foreground">+</div>
      <span className="text-[13px] font-semibold tracking-tight">Physics Portal</span>
    </div>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5 px-2 py-1">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) => cn('flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground', isActive && 'bg-accent text-foreground')}
        >
          <Icon className="size-4" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function ContextSelectors() {
  const { years, sections, yearId, sectionId, setYearId, setSectionId } = useWorkspace();
  return (
    <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
      <Select value={yearId ?? ''} onValueChange={setYearId} disabled={!years.length}>
        <SelectTrigger size="sm" aria-label="Academic year" className="min-w-0 sm:min-w-28">
          <SelectValue placeholder="No academic year" />
        </SelectTrigger>
        <SelectContent>
          {years.map((y) => (
            <SelectItem key={y.id} value={y.id}>
              {y.label}
              {y.status === 'active' ? ' · active' : y.status === 'closed' ? ' · closed' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={sectionId ?? ''} onValueChange={setSectionId} disabled={!sections.length}>
        <SelectTrigger size="sm" aria-label="Class section" className="min-w-0 sm:min-w-20">
          <SelectValue placeholder="Section" />
        </SelectTrigger>
        <SelectContent>
          {sections.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              Class {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Shell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { loading, error, retry, sections } = useWorkspace();
  const { connected } = useRealtime(true);

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[13.5rem_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col border-r bg-sidebar md:flex">
        <Brand />
        <NavList />
      </aside>
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-64 gap-0 p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Main navigation</SheetDescription>
          <Brand />
          <NavList onNavigate={() => setMenuOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-1.5 border-b bg-background/85 px-3 backdrop-blur md:px-5">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMenuOpen(true)} aria-label="Open navigation">
            <Menu />
          </Button>
          <ContextSelectors />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={cn('mr-1 hidden items-center gap-1 rounded-full px-2 py-0.5 text-[11px] sm:inline-flex', connected ? 'text-state-finalized' : 'text-muted-foreground')}>
                  <Radio className="size-3" />
                  {connected ? 'Live' : 'Offline'}
                </span>
              </TooltipTrigger>
              <TooltipContent>{connected ? 'Changes made in other tabs appear automatically.' : 'Live updates are not connected. Pages still refresh when you save or return to them.'}</TooltipContent>
            </Tooltip>
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-5 md:px-6">
          {loading ? <FullPageSpinner /> : error ? <ErrorState error={error} onRetry={retry} /> : !sections.length ? <EmptyState title="No sections assigned" description="No class sections are assigned to your account yet. Ask the administrator to assign Class 1B–1H." /> : <Outlet />}
        </main>
      </div>
    </div>
  );
}

export function TeacherLayout() {
  return (
    <WorkspaceProvider>
      <Shell />
    </WorkspaceProvider>
  );
}
