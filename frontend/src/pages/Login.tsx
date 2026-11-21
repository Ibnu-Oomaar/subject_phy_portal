import { zodResolver } from '@hookform/resolvers/zod';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { useAuth } from '@/auth/AuthProvider';
import { FieldError } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/api';
import { ThemeToggle } from '@/theme/ThemeToggle';

const teacherSchema = z.object({ name: z.string().trim().min(1, 'Enter your registered name'), passcode: z.string().optional() });
const studentSchema = z.object({ studentId: z.string().trim().min(1, 'Enter your Student ID') });
type TeacherForm = z.infer<typeof teacherSchema>;
type StudentForm = z.infer<typeof studentSchema>;

/** Turns the backend's login failures into plain language. */
export function loginMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'RATE_LIMITED') {
      const seconds = Number((error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds ?? 0);
      const wait = seconds >= 90 ? `${Math.ceil(seconds / 60)} minutes` : seconds > 0 ? `${seconds} seconds` : 'a few minutes';
      return `Too many attempts. Please wait ${wait} and try again.`;
    }
    if (error.code === 'INVALID_CREDENTIALS') return 'These details were not recognised. Check them and try again.';
    if (error.code === 'NETWORK') return error.message;
    return error.message;
  }
  return 'Could not sign in. Please try again.';
}

function TeacherLogin({ onDone }: { onDone: () => void }) {
  const { loginTeacher } = useAuth();
  const [needsPasscode, setNeedsPasscode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<TeacherForm>({ resolver: zodResolver(teacherSchema), defaultValues: { name: '', passcode: '' } });
  const { errors, isSubmitting } = form.formState;

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={form.handleSubmit(async (values) => {
        setError(null);
        try {
          await loginTeacher(values.name, values.passcode);
          onDone();
        } catch (e) {
          if (e instanceof ApiError && e.code === 'PASSCODE_REQUIRED') {
            setNeedsPasscode(true);
            queueMicrotask(() => form.setFocus('passcode'));
            return;
          }
          setError(loginMessage(e));
        }
      })}
    >
      <div>
        <Label htmlFor="name" className="mb-1.5">Registered name</Label>
        <Input id="name" autoComplete="username" autoFocus aria-invalid={!!errors.name} placeholder="Your name as registered" {...form.register('name')} />
        <FieldError>{errors.name?.message}</FieldError>
      </div>
      {needsPasscode && (
        <div>
          <Label htmlFor="passcode" className="mb-1.5">
            <KeyRound className="size-3.5" /> Passcode
          </Label>
          <Input id="passcode" type="password" autoComplete="current-password" {...form.register('passcode')} />
          <p className="mt-1 text-xs text-muted-foreground">This account is protected by a passcode.</p>
        </div>
      )}
      {error && <FieldError>{error}</FieldError>}
      <Button type="submit" className="w-full" loading={isSubmitting}>
        {needsPasscode ? 'Verify and sign in' : 'Sign in as teacher'}
      </Button>
    </form>
  );
}

function StudentLogin({ onDone }: { onDone: () => void }) {
  const { loginStudent } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<StudentForm>({ resolver: zodResolver(studentSchema), defaultValues: { studentId: '' } });
  const { errors, isSubmitting } = form.formState;
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={form.handleSubmit(async (values) => {
        setError(null);
        try {
          await loginStudent(values.studentId);
          onDone();
        } catch (e) {
          setError(loginMessage(e));
        }
      })}
    >
      <div>
        <Label htmlFor="studentId" className="mb-1.5">Student ID</Label>
        <Input id="studentId" autoComplete="off" autoCapitalize="characters" aria-invalid={!!errors.studentId} placeholder="For example 2026-0142" {...form.register('studentId')} />
        <FieldError>{errors.studentId?.message}</FieldError>
      </div>
      {error && <FieldError>{error}</FieldError>}
      <Button type="submit" className="w-full" loading={isSubmitting}>
        View my results
      </Button>
    </form>
  );
}

export default function Login() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  if (!loading && session) return <Navigate to={session.role === 'teacher' ? (from && !from.startsWith('/student') ? from : '/') : '/student'} replace />;

  const done = () => navigate(from ?? '/', { replace: true });
  return (
    <div className="relative flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="absolute top-3 right-3">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-xl leading-none font-bold text-primary-foreground shadow-sm">+</div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Physics Data Entry Portal</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">Class 1B – 1H marks, results and reports</p>
          </div>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sign in</CardTitle>
            <CardDescription>Choose how you use the portal.</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="teacher">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="teacher">Teacher</TabsTrigger>
                <TabsTrigger value="student">Student</TabsTrigger>
              </TabsList>
              <TabsContent value="teacher" className="pt-1">
                <TeacherLogin onDone={done} />
              </TabsContent>
              <TabsContent value="student" className="pt-1">
                <StudentLogin onDone={() => navigate('/student', { replace: true })} />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
        <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5" /> Students can only see their own results.
        </p>
      </div>
    </div>
  );
}
