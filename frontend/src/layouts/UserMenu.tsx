import { ChevronsUpDown, LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { errorMessage } from '@/lib/api';

export function UserMenu() {
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  if (!session) return null;
  const name = session.role === 'teacher' ? session.user.name : session.user.fullName;
  const sub = session.role === 'teacher' ? 'Physics teacher' : `Student ${session.user.studentId}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-9 max-w-52 justify-start gap-2 px-1.5 sm:px-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">{name.slice(0, 1).toUpperCase()}</span>
          <span className="hidden min-w-0 truncate text-left sm:block">{name}</span>
          <ChevronsUpDown className="hidden size-3.5 opacity-60 sm:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <span className="block truncate text-[13px] text-foreground">{name}</span>
          <span className="block text-xs font-normal">{sub}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={async () => {
            try {
              await logout();
              navigate('/login', { replace: true });
            } catch (e) {
              toast.error(errorMessage(e));
            }
          }}
        >
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
