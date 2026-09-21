import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { HostsService } from '../../hosts/hosts.service';
import { AutomationService } from '../automation.service';
import { Reboot } from './reboot';
import { RebootRun, RebootsService } from './reboots.service';

const review: RebootRun = { id: 'review-1', targetLabel: 'Ubuntu Server', phase: 'review', active: false, stopRequested: false,
  results: [{ host: { id: 'host-1', settings: { name: 'Ubuntu', address: '192.0.2.1', username: 'root', port: 22,
    authentication: { kind: 'keyFile', filename: 'key' } } }, state: 'ready', message: 'No reboot requested.', logs: 'Review complete', rebootRequired: true,
    plan: { bootId: 'old-boot', os: 'Ubuntu', createdAt: 1, requestedBy: ['libc6'], failedServices: [], sshStartup: 'ssh.socket' } }] };

describe('Reboot review', () => {
  let fixture: ComponentFixture<Reboot>;
  let component: Reboot;
  let service: Record<'latest' | 'preview' | 'apply' | 'refresh' | 'stop', ReturnType<typeof vi.fn>>;
  beforeEach(async () => {
    service = { latest: vi.fn().mockResolvedValue(null), preview: vi.fn().mockResolvedValue(review),
      apply: vi.fn().mockResolvedValue({ ...review, phase: 'apply', active: true }), refresh: vi.fn().mockResolvedValue(review), stop: vi.fn().mockResolvedValue(undefined) };
    await TestBed.configureTestingModule({ imports: [Reboot], providers: [provideRouter([]),
      { provide: RebootsService, useValue: service },
      { provide: HostsService, useValue: { desktop: true, list: vi.fn().mockResolvedValue([review.results[0].host]) } },
      { provide: AutomationService, useValue: { groups: vi.fn().mockResolvedValue([]) } },
    ] }).compileComponents();
    fixture = TestBed.createComponent(Reboot); component = fixture.componentInstance; await fixture.whenStable();
  });
  afterEach(() => fixture.destroy());
  it('does not dispatch from navigation or review; confirmation is required', async () => {
    expect(service.preview).not.toHaveBeenCalled(); expect(service.apply).not.toHaveBeenCalled();
    component.selection.hostIds.set(['host-1']); service.latest.mockResolvedValue(review);
    await component.preview(); fixture.detectChanges();
    expect(service.preview).toHaveBeenCalledExactlyOnceWith({ hostIds: ['host-1'], groupIds: [] });
    expect(fixture.nativeElement.textContent).toContain('Requested by: libc6');
    expect(fixture.nativeElement.textContent).toContain('SSH verified during review: ssh.socket enabled at boot');
    expect(fixture.nativeElement.textContent).toContain('Reboot interrupts every service');
    await component.apply(); expect(service.apply).not.toHaveBeenCalled();
    const checkbox = fixture.nativeElement.querySelector('footer input') as HTMLInputElement;
    checkbox.click(); fixture.detectChanges();
    component.selection.hostIds.set(['different-host']);
    await component.apply();
    expect(service.apply).toHaveBeenCalledExactlyOnceWith(review.id);
    expect(component.acknowledged()).toBe(false);
  });
  it('clears acknowledgement when a different review is loaded and blocks stale results', async () => {
    service.latest.mockResolvedValue(review); await component.poll(); component.acknowledged.set(true);
    service.latest.mockResolvedValue({ ...review, id: 'review-2' }); await component.poll();
    expect(component.acknowledged()).toBe(false);
    component.acknowledged.set(true); service.latest.mockRejectedValue('IPC unavailable'); await component.poll();
    await component.apply(); expect(service.apply).not.toHaveBeenCalled();
  });
  it('only refreshes an unconfirmed outcome and never resubmits it', async () => {
    service.latest.mockResolvedValue({ ...review, phase: 'finished', results: [{ ...review.results[0], state: 'unknown' }] });
    await component.poll(); component.selection.hostIds.set(['host-1']); component.acknowledged.set(true);
    await component.preview(); await component.apply(); await component.refresh();
    expect(service.preview).not.toHaveBeenCalled(); expect(service.apply).not.toHaveBeenCalled();
    expect(service.refresh).toHaveBeenCalledExactlyOnceWith(review.id);
  });
  it('leaves an active reboot running when navigating away', async () => {
    service.latest.mockResolvedValue({ ...review, phase: 'apply', active: true }); await component.poll();
    fixture.destroy(); expect(service.stop).not.toHaveBeenCalled();
  });
});
