import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AutomationService, PingRun } from './automation.service';
import { AutomationRunner } from './automation-runner.service';
import { InventorySelection } from '../hosts/inventory-selection.service';
import { HostsService } from '../hosts/hosts.service';

const host = { id: 'h1', settings: { name: 'Alpha', address: '192.0.2.1', username: 'test', port: 22, authentication: { kind: 'keyFile' as const, filename: 'key' } } };
const run: PingRun = { id: 'r1', active: true, elapsedMs: 0, targetLabel: 'Alpha', message: '', results: [{ host, outcome: 'waiting', diagnostics: '' }] };
describe('Session automation selection', () => {
  let selection: InventorySelection;
  let runner: AutomationRunner;
  let service: { availability: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> };
  let navigate: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    service = { availability: vi.fn().mockResolvedValue('ansible'), start: vi.fn().mockResolvedValue(run) };
    navigate = vi.fn().mockResolvedValue(true);
    TestBed.configureTestingModule({ providers: [{ provide: AutomationService, useValue: service }, { provide: HostsService, useValue: { desktop: true } }, { provide: Router, useValue: { navigateByUrl: navigate } }] });
    selection = TestBed.inject(InventorySelection); runner = TestBed.inject(AutomationRunner);
    selection.hosts.set([host]);
    selection.groups.set([{ id: 'g1', name: 'One', memberIds: ['h1'] }, { id: 'g2', name: 'Two', memberIds: ['h1'] }]);
  });
  it('keeps explicit host and group choices independent and deduplicates their union', () => {
    selection.select(['h1'], true); selection.selectGroup('g1', true); selection.selectGroup('g2', true);
    expect(selection.selectedHosts()).toEqual([host]);
    selection.selectGroup('g1', false);
    expect(selection.snapshot()).toEqual({ hostIds: ['h1'], groupIds: ['g2'] });
    selection.select(['h1'], false);
    expect(selection.selectedHosts()).toEqual([host]);
  });
  it('runs once with the captured choices, consumes them after acceptance, and retains new choices', async () => {
    selection.select(['h1'], true); selection.selectGroup('g1', true);
    let finish!: (value: PingRun) => void;
    service.start.mockImplementation(() => new Promise<PingRun>(resolve => { finish = resolve; }));
    const pending = runner.runPing(); await Promise.resolve();
    expect(selection.hasSelection()).toBe(true);
    selection.selectGroup('g2', true);
    await runner.runPing();
    expect(service.start).toHaveBeenCalledExactlyOnceWith({ hostIds: ['h1'], groupIds: ['g1'] });
    finish(run); await pending;
    expect(selection.snapshot()).toEqual({ hostIds: [], groupIds: ['g2'] });
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/automation/ping');
  });
  it('preserves choices when availability or backend start fails', async () => {
    selection.selectGroup('g1', true);
    service.availability.mockRejectedValueOnce('Missing Ansible');
    await runner.runPing();
    expect(selection.groupIds()).toEqual(['g1']);
    expect(service.start).not.toHaveBeenCalled();
    service.start.mockRejectedValueOnce('A ping is already running.');
    await runner.runPing();
    expect(selection.groupIds()).toEqual(['g1']);
    expect(runner.error()).toBe('A ping is already running.');
    expect(navigate).not.toHaveBeenCalled();
  });
  it('does nothing on empty selection and does not silently prune missing choices', async () => {
    await runner.runPing(); expect(service.start).not.toHaveBeenCalled();
    selection.select(['missing'], true); selection.selectGroup('deleted', true);
    expect(selection.missingCount()).toBe(2);
    expect(selection.snapshot()).toEqual({ hostIds: ['missing'], groupIds: ['deleted'] });
  });
});
