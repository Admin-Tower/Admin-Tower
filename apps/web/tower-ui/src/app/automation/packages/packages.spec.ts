import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { HostsService } from '../../hosts/hosts.service';
import { AutomationService } from '../automation.service';
import { Packages } from './packages';
import { PackageRun, PackageUpdatesService } from './package-updates.service';

const review: PackageRun = {
  id: 'preview-1', targetLabel: 'Ubuntu servers', phase: 'review', active: false, stopRequested: false,
  results: [{ host: { id: 'host-1', settings: { name: 'Ubuntu', address: '192.0.2.1', username: 'root', port: 22,
    authentication: { kind: 'keyFile', filename: 'key' } } }, state: 'ready', message: 'Ready', rebootRequired: false,
    plan: { os: 'Ubuntu 24.04', createdAt: 1, failedServices: [], deferred: ['linux-image-generic'],
      packages: [{ name: 'curl:amd64', fromVersion: '1', toVersion: '2' }] } }],
};

describe('Ubuntu package updates', () => {
  let fixture: ComponentFixture<Packages>;
  let component: Packages;
  let service: Record<'latest' | 'preview' | 'apply' | 'refresh' | 'stop', ReturnType<typeof vi.fn>>;
  beforeEach(async () => {
    service = { latest: vi.fn().mockResolvedValue(null), preview: vi.fn().mockResolvedValue(review),
      apply: vi.fn().mockResolvedValue({ ...review, phase: 'apply', active: true }),
      refresh: vi.fn().mockResolvedValue(review), stop: vi.fn().mockResolvedValue(undefined) };
    await TestBed.configureTestingModule({ imports: [Packages], providers: [provideRouter([]),
      { provide: PackageUpdatesService, useValue: service },
      { provide: HostsService, useValue: { desktop: true, list: vi.fn().mockResolvedValue([review.results[0].host]) } },
      { provide: AutomationService, useValue: { groups: vi.fn().mockResolvedValue([]) } },
    ] }).compileComponents();
    fixture = TestBed.createComponent(Packages); component = fixture.componentInstance;
    await fixture.whenStable();
  });
  afterEach(() => fixture.destroy());

  it('requires explicit targets, previews only, and consumes only submitted choices', async () => {
    await component.preview(); expect(service.preview).not.toHaveBeenCalled();
    component.selection.hostIds.set(['host-1']);
    service.latest.mockResolvedValue(review);
    await component.preview();
    expect(service.preview).toHaveBeenCalledExactlyOnceWith({ hostIds: ['host-1'], groupIds: [] });
    expect(component.selection.hostIds()).toEqual([]);
    expect(service.apply).not.toHaveBeenCalled();
    expect(component.canApply()).toBe(true);
  });
  it('applies the reviewed run ID regardless of new inventory selections', async () => {
    service.latest.mockResolvedValue(review); await component.poll();
    component.selection.hostIds.set(['different-host']);
    await component.apply();
    expect(service.apply).toHaveBeenCalledExactlyOnceWith('preview-1');
  });
  it('blocks apply without a complete preview or when status is stale', async () => {
    await component.apply(); expect(service.apply).not.toHaveBeenCalled();
    service.latest.mockResolvedValue({ ...review, results: [{ ...review.results[0], state: 'failed' }] });
    await component.poll(); expect(component.canApply()).toBe(false);
    service.latest.mockResolvedValue(review); await component.poll();
    service.latest.mockRejectedValue('IPC unavailable'); await component.poll();
    await component.apply(); expect(service.apply).not.toHaveBeenCalled();
  });
  it('blocks new previews while the remote outcome is unconfirmed', async () => {
    service.latest.mockResolvedValue({ ...review, phase: 'finished', results: [{ ...review.results[0], state: 'unknown' }] });
    await component.poll(); component.selection.hostIds.set(['host-1']);
    expect(component.canPreview()).toBe(false);
    await component.preview(); expect(service.preview).not.toHaveBeenCalled();
    await component.refresh(); expect(service.refresh).toHaveBeenCalledExactlyOnceWith(review.id);
    expect(service.apply).not.toHaveBeenCalled();
  });
  it('keeps selection on preview failure and blocks duplicate dispatch', async () => {
    component.selection.hostIds.set(['host-1']);
    let reject!: (error: string) => void;
    service.preview.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    const pending = component.preview(); await component.preview();
    reject('Sudo unavailable'); await pending;
    expect(service.preview).toHaveBeenCalledTimes(1);
    expect(component.selection.hostIds()).toEqual(['host-1']);
    expect(component.error()).toContain('Sudo unavailable');
  });
  it('does not cancel an installation on navigation and ignores stale polls', async () => {
    let resolve!: (run: PackageRun) => void;
    service.latest.mockImplementation(() => new Promise<PackageRun>(done => { resolve = done; }));
    const pending = component.poll(); fixture.destroy(); resolve(review); await pending;
    expect(component.run()).toBeNull(); expect(service.stop).not.toHaveBeenCalled();
  });
  it('shows reviewed package versions, exclusions and explicit apply', async () => {
    service.latest.mockResolvedValue(review); await component.poll(); fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('curl:amd64'); expect(text).toContain('linux-image-generic');
    expect(text).toContain('Updates may restart services');
    expect(text).toContain('Apply reviewed updates to 1 host');
  });
  it.each([true, false])('explains a completed empty preview with deferred packages: %s', async (hasDeferred) => {
    const result = structuredClone(review.results[0]);
    result.plan!.packages = [];
    result.plan!.deferred = hasDeferred ? ['linux-firmware:amd64', 'software-properties-common:amd64'] : [];
    service.latest.mockResolvedValue({ ...review, results: [result] });
    await component.poll(); fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Preview complete · nothing to apply');
    expect(text).toContain(hasDeferred ? 'No updates can be applied by this task' : 'No package updates available');
    expect(text).toContain(hasDeferred ? 'Updates deferred' : 'Up to date');
    expect(text).not.toContain('Ready for review');
    expect(text).not.toContain('Updates may restart services');
    expect(text).not.toContain('Apply reviewed updates');
    if (hasDeferred) {
      expect(text).toContain('All 2 available package updates are deferred');
      expect(text).not.toContain('Up to date');
    }
    await component.apply();
    expect(service.apply).not.toHaveBeenCalled();
  });
  it('keeps apply available when another host has eligible updates', async () => {
    const empty = structuredClone(review.results[0]);
    empty.host.id = 'host-2'; empty.plan!.packages = [];
    service.latest.mockResolvedValue({ ...review, results: [...review.results, empty] });
    await component.poll(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Updates deferred');
    expect(fixture.nativeElement.textContent).toContain('Apply reviewed updates to 2 hosts');
    expect(fixture.nativeElement.textContent).not.toContain('nothing to apply');
    expect(component.canApply()).toBe(true);
  });
  it('offers stop after current host, not immediate cancellation', async () => {
    service.latest.mockResolvedValue({ ...review, phase: 'apply', active: true });
    await component.poll(); await component.stop();
    expect(service.stop).toHaveBeenCalledExactlyOnceWith(review.id);
  });
  it('does not run desktop commands in a browser', async () => {
    fixture.destroy(); TestBed.resetTestingModule(); service.latest.mockClear();
    await TestBed.configureTestingModule({ imports: [Packages], providers: [provideRouter([]),
      { provide: PackageUpdatesService, useValue: service }, { provide: HostsService, useValue: { desktop: false } },
      { provide: AutomationService, useValue: {} },
    ] }).compileComponents();
    fixture = TestBed.createComponent(Packages); await fixture.whenStable();
    expect(service.latest).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Open Admin-Tower for Linux');
  });
});
