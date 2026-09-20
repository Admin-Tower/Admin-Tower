import { InventorySelection } from '../../hosts/inventory-selection.service';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { HostsService } from '../../hosts/hosts.service';
import { AutomationService, PingRun } from '../automation.service';
import { Ping } from './ping';

const group = { id: 'group-1', name: 'Servers', memberIds: ['host-1'] };
const run: PingRun = { id: 'run-1', targetLabel: 'Servers', active: true, elapsedMs: 0, message: '', results: [{
  host: { id: 'host-1', settings: { name: 'Server', address: '192.0.2.1', username: 'fixture', port: 22, authentication: { kind: 'keyFile', filename: 'key' } } },
  outcome: 'waiting', diagnostics: '',
}] };

describe('Ping automation', () => {
  let fixture: ComponentFixture<Ping>;
  let component: Ping;
  let service: { groups: ReturnType<typeof vi.fn>; latest: ReturnType<typeof vi.fn>; availability: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
  beforeEach(async () => {
    service = { groups: vi.fn().mockResolvedValue([group]), latest: vi.fn().mockResolvedValue(null), availability: vi.fn().mockResolvedValue('ansible'), start: vi.fn().mockResolvedValue(run), cancel: vi.fn().mockResolvedValue(undefined) };
    await TestBed.configureTestingModule({ imports: [Ping], providers: [provideRouter([]), { provide: AutomationService, useValue: service }, { provide: HostsService, useValue: { desktop: true, list: vi.fn().mockResolvedValue([run.results[0].host]) } }] }).compileComponents();
    vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    fixture = TestBed.createComponent(Ping);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });
  afterEach(() => fixture.destroy());

  it('requires saved targets and sends only their IDs', async () => {
    await component.start();
    expect(service.start).not.toHaveBeenCalled();
    component.selection.hostIds.set(['host-1']);
    service.latest.mockResolvedValue(run);
    await component.start();
    expect(service.start).toHaveBeenCalledExactlyOnceWith({ groupIds: [], hostIds: ['host-1'] });
    expect(component.run()).toEqual(run);
    expect(component.canRun()).toBe(false);
  });
  it('uses the existing inventory selection and consumes it on accepted start', async () => {
    const selection = TestBed.inject(InventorySelection);
    selection.select(['host-1'], true);
    expect(component.targetHosts()).toEqual([run.results[0].host]);
    await component.start();
    expect(service.start).toHaveBeenCalledExactlyOnceWith({ hostIds: ['host-1'], groupIds: [] });
    expect(selection.hostIds()).toEqual([]);
  });
  it('blocks missing selected hosts instead of silently running a partial selection', async () => {
    component.selection.hostIds.set(['host-1', 'deleted']);
    await component.refreshTargets();
    expect(component.selection.hostIds()).toEqual(['host-1', 'deleted']);
    expect(component.canRun()).toBe(false);
    await component.start();
    expect(service.start).not.toHaveBeenCalled();
    component.selection.hostIds.set(['host-1']);
    expect(component.canRun()).toBe(true);
  });
  it('retains the latest run and does not cancel it on navigation', async () => {
    service.latest.mockResolvedValue(run);
    await component.poll();
    expect(component.run()?.active).toBe(true);
    fixture.destroy();
    expect(service.cancel).not.toHaveBeenCalled();
  });
  it('discards an in-flight poll after navigation', async () => {
    let resolve!: (run: PingRun) => void;
    service.latest.mockImplementation(() => new Promise<PingRun>(done => { resolve = done; }));
    const pending = component.poll();
    fixture.destroy();
    resolve(run);
    await pending;
    expect(component.run()).toBeNull();
  });
  it('prevents duplicate starts and keeps the selected target while availability is pending', async () => {
    component.selection.hostIds.set(['host-1']);
    let resolve!: () => void;
    service.availability.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
    const pending = component.start();
    component.selection.hostIds.set(['changed']);
    await component.start();
    resolve();
    await pending;
    expect(service.start).toHaveBeenCalledExactlyOnceWith({ groupIds: [], hostIds: ['host-1'] });
  });
  it('keeps previous results when Ansible is unavailable', async () => {
    const previous = { ...run, active: false };
    service.latest.mockResolvedValue(previous);
    await component.poll();
    component.selection.hostIds.set(['host-1']);
    service.availability.mockRejectedValue('Ansible is missing');
    await component.start();
    expect(component.error()).toBe('Ansible is missing');
    expect(component.run()).toEqual(previous);
    expect(service.start).not.toHaveBeenCalled();
  });
  it('blocks execution until run status can be read and lets the user retry', async () => {
    service.latest.mockRejectedValueOnce('IPC unavailable');
    await component.poll();
    component.selection.hostIds.set(['host-1']);
    expect(component.canRun()).toBe(false);
    await component.poll();
    expect(component.pollError()).toBe('');
    expect(component.canRun()).toBe(true);
  });
  it('cancels by run ID and refreshes the results', async () => {
    service.latest.mockResolvedValue(run);
    await component.poll();
    service.latest.mockResolvedValue({ ...run, active: false, results: [{ ...run.results[0], outcome: 'cancelled' }] });
    await component.cancel();
    expect(service.cancel).toHaveBeenCalledExactlyOnceWith(run.id);
    expect(component.completed()).toBe(1);
    expect(component.needsAttention()).toBe(1);
  });
  it('does not load inventory or invoke Ansible in the browser', async () => {
    fixture.destroy();
    TestBed.resetTestingModule();
    service.groups.mockClear(); service.latest.mockClear();
    await TestBed.configureTestingModule({ imports: [Ping], providers: [provideRouter([]), { provide: AutomationService, useValue: service }, { provide: HostsService, useValue: { desktop: false } }] }).compileComponents();
    fixture = TestBed.createComponent(Ping);
    await fixture.whenStable();
    expect(service.groups).not.toHaveBeenCalled();
    expect(service.latest).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Open Admin-Tower for Linux');
  });
});
