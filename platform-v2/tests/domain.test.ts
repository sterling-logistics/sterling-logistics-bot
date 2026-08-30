import { describe, expect, it } from 'vitest';
import { canTransitionJob, expectedPayoutBalance, payoutConfirmationMatches } from '../src/domain.js';

describe('job lifecycle', () => {
  it('allows only the intended happy-path transitions', () => {
    expect(canTransitionJob('assigned', 'in_progress')).toBe(true);
    expect(canTransitionJob('in_progress', 'submitted')).toBe(true);
    expect(canTransitionJob('submitted', 'approved')).toBe(true);
    expect(canTransitionJob('approved', 'paid')).toBe(true);
  });

  it('blocks dangerous skips and duplicate payment transitions', () => {
    expect(canTransitionJob('assigned', 'approved')).toBe(false);
    expect(canTransitionJob('submitted', 'paid')).toBe(false);
    expect(canTransitionJob('paid', 'paid')).toBe(false);
    expect(canTransitionJob('declined', 'approved')).toBe(false);
  });
});

describe('payout confirmation', () => {
  it('calculates the expected game balance', () => {
    expect(expectedPayoutBalance(12500, 875.5)).toBe(13375.5);
  });

  it('accepts a correct applied payout and rejects a wrong amount', () => {
    expect(payoutConfirmationMatches(1000, 1250, 250)).toBe(true);
    expect(payoutConfirmationMatches(1000, 1249, 250)).toBe(false);
  });

  it('rejects invalid negative balances or payouts', () => {
    expect(() => expectedPayoutBalance(-1, 10)).toThrow();
    expect(() => expectedPayoutBalance(10, -1)).toThrow();
  });
});
