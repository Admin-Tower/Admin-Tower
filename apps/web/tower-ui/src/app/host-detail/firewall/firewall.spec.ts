import { TestBed } from '@angular/core/testing';
import { Firewall } from './firewall';
import { nftFixture } from './firewall.fixture';

describe('Firewall view', () => {
  async function setup() {
    await TestBed.configureTestingModule({ imports: [Firewall] }).compileComponents();
    const fixture = TestBed.createComponent(Firewall);
    fixture.componentRef.setInput('sections', [
      { id: 'nftables', status: 'ok', output: nftFixture, truncated: false },
      { id: 'iptables', status: 'denied', output: 'Operation not permitted', truncated: false },
      { id: 'ufw', status: 'unavailable', output: 'Not installed', truncated: false },
    ]);
    await fixture.whenStable(); return fixture;
  }
  it('selects readable data and filters by exact chain, action and full conditions', async () => {
    const fixture = await setup(), view = fixture.componentInstance;
    expect(view.current().section.id).toBe('nftables');
    view.chooseScope(view.current().scopes[0].key); expect(view.rows()).toHaveLength(2);
    view.action.set('ACCEPT'); view.query.set('office'); expect(view.rows()).toHaveLength(0);
    view.query.set('trusted'); expect(view.rows()).toHaveLength(1);
    view.clear(); expect(view.rows()).toHaveLength(3);
  });
  it('restores source order after sorting and keeps details tied to a rule', async () => {
    const fixture = await setup(), view = fixture.componentInstance;
    view.sort('action'); view.sort('action');
    expect(view.rows()[0].action).toBe('JUMP → trusted');
    view.restoreOrder(); expect(view.rows().map(r => r.id)).toEqual([1, 2, 3]);
    view.toggle(view.rows()[0]); expect(view.expanded()).toBe(1);
    view.choose('iptables'); expect(view.expanded()).toBeNull();
    expect(view.status(view.current())).toBe('Permission required');
    expect(view.current().rules).toEqual([]);
  });
  it('requires an explicit reviewed inspection request and hides raw output initially', async () => {
    const fixture = await setup(), view = fixture.componentInstance;
    const requested = vi.fn(); view.inspect.subscribe(requested);
    view.choose('iptables'); await fixture.whenStable();
    expect(requested).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('.diagnostics').open).toBe(false);
    fixture.componentRef.setInput('canInspect', true); await fixture.whenStable();
    const button = [...fixture.nativeElement.querySelectorAll('button')].find((b: unknown) => (b as HTMLButtonElement).textContent?.includes('Review privileged')) as HTMLButtonElement;
    button.click(); expect(requested).toHaveBeenCalledOnce();
  });
  it('keeps tables and chains separate through sorting, filtering and pagination, including empty chains', async () => {
    const fixture = await setup(), view = fixture.componentInstance;
    fixture.componentRef.setInput('sections', [{
      id: 'iptables', status: 'ok', truncated: false,
      output: '*filter\n:INPUT DROP [0:0]\n:OUTPUT ACCEPT [0:0]\n:EMPTY - [0:0]\n-A INPUT -j DROP\n-A OUTPUT -j ACCEPT\n-A INPUT -j ACCEPT\nCOMMIT\n*nat\n:INPUT ACCEPT [0:0]\n-A INPUT -j RETURN\nCOMMIT',
    }]);
    view.choose('iptables'); await fixture.whenStable();
    expect(view.groups().map(g => [g.scope?.table, g.scope?.name])).toEqual([['filter', 'INPUT'], ['filter', 'OUTPUT'], ['filter', 'EMPTY'], ['nat', 'INPUT']]);
    expect(fixture.nativeElement.querySelectorAll('.chain-heading')).toHaveLength(4);
    expect(view.rows().map(r => r.id)).toEqual([1, 3, 2, 4]);
    view.sort('action');
    expect(view.rows().map(r => r.id)).toEqual([3, 1, 2, 4]);
    view.restoreOrder(); view.pageSize.set(1); view.page.set(1);
    expect(view.groups()[0].scope?.name).toBe('INPUT');
    expect(view.groups()[0].rows[0].order).toBe(2);
    view.page.set(0); view.pageSize.set(25); view.query.set('RETURN');
    expect(view.groups()).toHaveLength(1);
    expect(view.groups()[0].scope?.table).toBe('nat');
    view.clear(); view.chooseScope(view.current().scopes[2].key);
    expect(view.groups()).toHaveLength(1);
    expect(view.groups()[0].rows).toEqual([]);
  });

  it('follows only same-table targets and restores filters and pagination on return', async () => {
    const fixture = await setup(), view = fixture.componentInstance;
    fixture.componentRef.setInput('sections', [{
      id: 'iptables', status: 'ok', truncated: false,
      output: '*filter\n:INPUT DROP [0:0]\n:trusted - [0:0]\n-A INPUT -j trusted\n-A trusted -j RETURN\nCOMMIT\n*nat\n:trusted - [0:0]\n-A trusted -j ACCEPT\nCOMMIT',
    }]);
    view.choose('iptables'); await fixture.whenStable();
    view.query.set('trusted'); view.action.set('JUMP → trusted');
    const target = view.current().scopes[1];
    view.toggleChain(target.key); view.follow(view.rows()[0]);
    expect(view.selectedScope()?.table).toBe('filter');
    expect(view.selectedScope()?.name).toBe('trusted');
    expect(view.query()).toBe(''); expect(view.action()).toBe('');
    expect(view.collapsed()).not.toContain(target.key);
    expect(view.rows()).toHaveLength(1);
    view.back();
    expect(view.query()).toBe('trusted'); expect(view.action()).toBe('JUMP → trusted');
    expect(view.match('!= eth0')).toBe('Except eth0');
    view.showInterfaces.set(true); view.showCounters.set(true);
    expect(view.columns().map(c => c.key)).toContain('inputInterface');
    expect(view.columns().map(c => c.key)).toContain('packets');
  });

});
