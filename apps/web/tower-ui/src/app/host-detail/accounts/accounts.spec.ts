import { TestBed } from '@angular/core/testing';
import { Accounts } from './accounts';

describe('Accounts explorer', () => {
  async function setup() {
    await TestBed.configureTestingModule({ imports: [Accounts] }).compileComponents();
    const fixture = TestBed.createComponent(Accounts);
    fixture.componentRef.setInput('sections', [
      { id: 'users', status: 'ok', truncated: false, output: 'root:0:0:Root:/root:/bin/bash\nalice:1000:1000:Alice:/home/alice:/bin/bash\nworker:101:1001:Worker:/srv/worker:/usr/sbin/nologin' },
      { id: 'groups', status: 'ok', truncated: false, output: 'root:0:\nalice:1000:\nops:1001:alice,external\nempty:2000:' },
    ]);
    fixture.componentRef.setInput('canManage', true);
    await fixture.whenStable(); return fixture;
  }
  it('resolves primary groups and supplementary memberships without conflating them', async () => {
    const fixture = await setup(), view = fixture.componentInstance;
    const alice = view.users().find(u => u.name === 'alice')!;
    expect(view.primaryLabel(alice)).toBe('alice');
    expect(view.supplementary(alice).map(g => g.name)).toEqual(['ops']);
    const ops = view.groups().find(g => g.name === 'ops')!;
    expect(view.primaryMembers(ops).map(u => u.name)).toEqual(['worker']);
    expect(ops.members).toEqual(['alice', 'external']);
    view.query.set('ops'); expect(view.rows().map(r => r.cells[0])).toEqual(['alice', 'worker']);
    view.clear(); view.filter.set('shell'); expect(view.rows()[0].cells[0]).toBe('worker');
    view.choose('groups'); view.filter.set('empty'); expect(view.rows().map(r => r.cells[0])).toEqual(['empty']);
  });
  it('only emits valid reviewed supplementary changes, never primary or duplicate changes', async () => {
    const fixture = await setup(), view = fixture.componentInstance, review = vi.fn();
    view.review.subscribe(review);
    view.membership('alice', 'alice', false);
    view.membership('alice', 'ops', true);
    view.membership('external', 'ops', false);
    expect(review).not.toHaveBeenCalled();
    view.membership('alice', 'ops', false);
    expect(review).toHaveBeenCalledExactlyOnceWith({ kind: 'membership', username: 'alice', group: 'ops', add: false });
    fixture.componentRef.setInput('canManage', false); await fixture.whenStable();
    view.membership('worker', 'empty', true); expect(review).toHaveBeenCalledTimes(1);
  });
  it('sorts IDs numerically and clamps pages after filtering or refresh', async () => {
    const fixture = await setup(), view = fixture.componentInstance;
    view.sort(1); expect(view.rows().map(r => r.cells[1])).toEqual(['0', '101', '1000']);
    view.size.set(1); view.page.set(2); expect(view.visible()[0].cells[0]).toBe('alice');
    view.query.set('root'); expect(view.currentPage()).toBe(0);
    fixture.componentRef.setInput('sections', [{ id: 'users', status: 'denied', output: 'Permission denied', truncated: false }]);
    await fixture.whenStable();
    expect(view.users()).toEqual([]); expect(view.groups()).toEqual([]);
    expect(fixture.nativeElement.textContent).toContain('relationships may be incomplete');
    expect(fixture.nativeElement.querySelector('.diagnostics').open).toBe(false);
  });
});
