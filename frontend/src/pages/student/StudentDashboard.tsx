import { useQuery } from '@tanstack/react-query';
import { GraduationCap } from 'lucide-react';
import { useState } from 'react';
import { Banner, CardSkeleton, EmptyState, ErrorState, PageHeader } from '@/components/common';
import { ProfileView } from '@/components/ProfileView';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';
import type { StudentProfile, StudentYear } from '@/lib/types';

export default function StudentDashboard() {
  const years = useQuery({ queryKey: ['me', 'years'], queryFn: () => api.get<StudentYear[]>('/me/years') });
  const [chosen, setChosen] = useState<string | null>(null);
  const list = years.data ?? [];
  const yearId = list.find((y) => y.academicYearId === chosen)?.academicYearId ?? list.find((y) => y.status === 'active')?.academicYearId ?? list[0]?.academicYearId;

  const profile = useQuery({
    queryKey: ['me', 'profile', yearId],
    queryFn: () => api.get<StudentProfile>('/me/profile', { academicYearId: yearId }),
    enabled: !!yearId,
  });

  return (
    <div>
      <PageHeader
        title="My results"
        description="Your marks and progress. This page is read-only."
        actions={
          list.length > 1 && yearId ? (
            <Select value={yearId} onValueChange={setChosen}>
              <SelectTrigger size="sm" aria-label="Academic year" className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>{list.map((y) => <SelectItem key={y.academicYearId} value={y.academicYearId}>{y.academicYearLabel} · Class {y.sectionLabel}</SelectItem>)}</SelectContent>
            </Select>
          ) : undefined
        }
      />
      {years.isPending ? (
        <CardSkeleton className="h-64" />
      ) : years.isError ? (
        <ErrorState error={years.error} onRetry={() => void years.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState icon={GraduationCap} title="No results yet" description="You are not enrolled in an academic year yet. Please ask your Physics teacher." />
      ) : profile.isPending ? (
        <CardSkeleton className="h-64" />
      ) : profile.isError ? (
        <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />
      ) : (
        <>
          <Banner tone="info" icon={GraduationCap}>A mark that your teacher has not entered yet is shown as “Missing” with a dash. It is never counted as zero.</Banner>
          <ProfileView profile={profile.data} showFlags={false} />
        </>
      )}
    </div>
  );
}
