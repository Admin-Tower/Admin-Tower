import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { HostDetail } from './host-detail';
import { Host, HostOverview, HostsService } from '../hosts/hosts.service';

const host: Host = { id: 'one', settings: { name: 'Debian', address: 'example.com', username: 'admin', port: 22, authentication: { kind: 'keyFile', filename: 'id_ed25519' } } };
const overview: HostOverview = { collectedAt: 123, elevated: false, supported: true, sections: [
  { id: 'system', status: 'ok', output: 'ID=debian', truncated: false },
  { id: 'users', status: 'ok', output: 'admin:1000:1000::/home/admin:/bin/bash', truncated: false },
  { id: 'groups', status: 'ok', output: 'ops:1001:admin', truncated: false },
  { id: 'serviceFiles', status: 'ok', output: 'ssh.service enabled enabled', truncated: false },
  { id: 'nftables', status: 'denied', output: 'Operation not permitted', truncated: false },
] };

describe('HostDetail', () => {
  const params = new BehaviorSubject(convertToParamMap({ id: 'one' }));
  let service: { desktop: boolean; list: ReturnType<typeof vi.fn>; terminals: ReturnType<typeof vi.fn>; inspect: ReturnType<typeof vi.fn>; review: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; operation: ReturnType<typeof vi.fn> };
  beforeEach(async () => {
    params.next(convertToParamMap({ id: 'one' }));
    service = { desktop: true, list: vi.fn().mockResolvedValue([host]), terminals: vi.fn().mockResolvedValue([{ id: 'xterm', label: 'xterm' }]), inspect: vi.fn().mockResolvedValue(overview), review: vi.fn().mockResolvedValue({ id: 'review', host, summary: 'Create user alice', command: 'useradd alice', warning: 'Locked password', expiresAt: 9999999999 }), start: vi.fn().mockResolvedValue({ id: 'review', hostId: 'one', state: 'unknown', message: 'Connection lost', overview: null }), operation: vi.fn() };
    await TestBed.configureTestingModule({ imports: [HostDetail], providers: [provideRouter([]), { provide: ActivatedRoute, useValue: { paramMap: params } }, { provide: HostsService, useValue: service }] }).compileComponents();
  });
  afterEach(() => vi.useRealTimers());
  it('selecting a host inspects without launching or requesting privileges', async () => {
    const fixture = TestBed.createComponent(HostDetail); await fixture.whenStable();
    expect(service.inspect).toHaveBeenCalledWith('one');
    expect(service.review).not.toHaveBeenCalled(); expect(service.start).not.toHaveBeenCalled();
    expect(fixture.componentInstance.users()).toEqual(['admin']);
    expect(fixture.componentInstance.units()).toEqual(['ssh.service']);
    fixture.componentInstance.tab.set('firewall'); await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Permission required');
    expect(fixture.nativeElement.textContent).toContain('Read-only');
  });
  it('requires a review and consumes it once even when outcome is unknown', async () => {
    const fixture = TestBed.createComponent(HostDetail); await fixture.whenStable(); const component = fixture.componentInstance;
    await component.execute(); expect(service.start).not.toHaveBeenCalled();
    await component.prepare({ kind: 'createUser', username: 'alice' });
    expect(service.start).not.toHaveBeenCalled();
    await component.execute(); await component.execute();
    expect(service.start).toHaveBeenCalledExactlyOnceWith('review', 'xterm');
    expect(component.operation()?.state).toBe('unknown');
    expect(component.overview()).toEqual(overview);
    expect(service.operation).not.toHaveBeenCalled();
  });
  it('retains the previous snapshot on refresh failure', async () => {
    const fixture = TestBed.createComponent(HostDetail); await fixture.whenStable();
    service.inspect.mockRejectedValue('SSH failed'); await fixture.componentInstance.refresh();
    expect(fixture.componentInstance.overview()).toEqual(overview);
    expect(fixture.componentInstance.error()).toBe('SSH failed');
  });
  it('labels refreshed data with the native snapshot target', async () => {
    const fixture = TestBed.createComponent(HostDetail); await fixture.whenStable();
    const target = { ...host, settings: { ...host.settings, address: 'changed.example.com' } };
    service.inspect.mockResolvedValue({ ...overview, target });
    await fixture.componentInstance.refresh();
    expect(fixture.componentInstance.host()?.settings.address).toBe('changed.example.com');
  });
  it('disables changes on unsupported hosts', async () => {
    service.inspect.mockResolvedValue({ ...overview, supported: false });
    const fixture = TestBed.createComponent(HostDetail); await fixture.whenStable();
    await fixture.componentInstance.prepare({ kind: 'createGroup', group: 'ops' });
    expect(service.review).not.toHaveBeenCalled();
  });
  it('ignores a stale snapshot after selecting another host', async () => {
    let finish!: (value: HostOverview) => void;
    service.inspect.mockImplementationOnce(() => new Promise<HostOverview>(resolve => { finish = resolve; }));
    const fixture = TestBed.createComponent(HostDetail);
    await Promise.resolve(); await Promise.resolve();
    params.next(convertToParamMap({ id: 'missing' }));
    finish(overview); await fixture.whenStable();
    expect(fixture.componentInstance.overview()).toBeNull();
    expect(fixture.componentInstance.host()).toBeNull();
  });
  it('does not call native IPC in a browser', async () => {
    service.desktop = false;
    const fixture = TestBed.createComponent(HostDetail); await fixture.whenStable();
    expect(service.list).not.toHaveBeenCalled();
  });
});
