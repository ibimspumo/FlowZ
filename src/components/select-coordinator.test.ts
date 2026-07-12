import { describe, expect, it, vi } from 'vitest';
import { activateSelect, closeActiveSelect, deactivateSelect } from './select-coordinator';

describe('CustomSelect singleton coordinator', () => {
  it('closes a select in another node before activating the next one', () => {
    const closeFirst = vi.fn(); const closeSecond = vi.fn();
    activateSelect('node-a:model', closeFirst);
    activateSelect('node-b:format', closeSecond);
    expect(closeFirst).toHaveBeenCalledOnce();
    expect(closeSecond).not.toHaveBeenCalled();
    closeActiveSelect();
    expect(closeSecond).toHaveBeenCalledOnce();
  });

  it('does not let stale cleanup unregister the active select', () => {
    const closeFirst = vi.fn(); const closeSecond = vi.fn();
    activateSelect('first', closeFirst); activateSelect('second', closeSecond);
    deactivateSelect('first'); closeActiveSelect();
    expect(closeSecond).toHaveBeenCalledOnce();
  });
  it('coordinates project menu and field popovers in both opening orders',()=>{
    const closeProject=vi.fn();const closeField=vi.fn();
    activateSelect('project-menu',closeProject);activateSelect('node:model',closeField);expect(closeProject).toHaveBeenCalledOnce();
    activateSelect('project-menu',closeProject);expect(closeField).toHaveBeenCalledOnce();closeActiveSelect();expect(closeProject).toHaveBeenCalledTimes(2);
  });
});
