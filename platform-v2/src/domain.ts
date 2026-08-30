export type JobStatus = 'assigned' | 'in_progress' | 'submitted' | 'approved' | 'declined' | 'paid' | 'cancelled';

const allowed: Record<JobStatus, readonly JobStatus[]> = {
  assigned: ['in_progress', 'cancelled'],
  in_progress: ['submitted', 'cancelled'],
  submitted: ['approved', 'declined'],
  approved: ['paid'],
  declined: [],
  paid: [],
  cancelled: []
};

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return allowed[from].includes(to);
}

export function expectedPayoutBalance(balanceBefore: number, amount: number): number {
  if (!Number.isFinite(balanceBefore) || !Number.isFinite(amount) || balanceBefore < 0 || amount < 0) {
    throw new Error('invalid payout values');
  }
  return Math.round((balanceBefore + amount) * 100) / 100;
}

export function payoutConfirmationMatches(balanceBefore: number, balanceAfter: number, amount: number): boolean {
  return Math.abs(expectedPayoutBalance(balanceBefore, amount) - balanceAfter) <= 0.01;
}
