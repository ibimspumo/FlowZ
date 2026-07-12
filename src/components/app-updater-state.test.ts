import { describe, expect, it } from 'vitest';
import { advanceDownload, attemptUpdaterAction, finishDownload, OperationGate, startDownload, UPDATER_ERROR_ALERT_PROPS } from './app-updater-state';

describe('updater operation safety', () => {
  it('invalidates stale and disposed asynchronous operations', () => {
    const gate = new OperationGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
    gate.dispose();
    expect(gate.isCurrent(second)).toBe(false);
  });

  it('reports real bounded byte progress and supports unknown totals', () => {
    const bounded = advanceDownload(advanceDownload(startDownload(100), 40), 80);
    expect(bounded).toEqual({ downloaded: 100, total: 100 });
    expect(finishDownload(startDownload(25))).toEqual({ downloaded: 25, total: 25 });
    expect(advanceDownload(startDownload(), 12)).toEqual({ downloaded: 12 });
    expect(advanceDownload(startDownload(), -1)).toEqual({ downloaded: 0 });
  });

  it('turns close and relaunch rejections into user-visible messages', async () => {
    expect(await attemptUpdaterAction(async () => undefined)).toBeUndefined();
    expect(await attemptUpdaterAction(async () => { throw new Error('Neustart verweigert'); })).toBe('Neustart verweigert');
    expect(await attemptUpdaterAction(async () => { throw 'Ressource geschlossen'; })).toBe('Ressource geschlossen');
  });

  it('announces the concrete updater error assertively even when the phase stays installed', () => {
    expect(UPDATER_ERROR_ALERT_PROPS).toEqual({
      role: 'alert',
      'aria-live': 'assertive',
      'aria-atomic': true,
    });
  });
});
