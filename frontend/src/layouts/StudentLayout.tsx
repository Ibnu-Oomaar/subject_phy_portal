import { Outlet } from 'react-router-dom';
import { ThemeToggle } from '@/theme/ThemeToggle';
import { UserMenu } from './UserMenu';

export function StudentLayout() {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur md:px-6">
        <div className="flex size-6 items-center justify-center rounded-md bg-primary text-sm leading-none font-bold text-primary-foreground">+</div>
        <span className="text-[13px] font-semibold tracking-tight">Physics Portal</span>
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <UserMenu />
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6">
        <Outlet />
      </main>
    </div>
  );
}
