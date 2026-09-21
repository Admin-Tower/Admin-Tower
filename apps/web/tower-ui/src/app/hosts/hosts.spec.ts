import { signal } from '@angular/core';
import { RebootsService, RebootRun } from '../automation/reboot/reboots.service';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Clipboard } from '@angular/cdk/clipboard';
import { MatSnackBar } from '@angular/material/snack-bar';
import { AutomationService, PingRun } from '../automation/automation.service';
import { Hosts } from './hosts';
import { Host, HostOverview, HostsService, HostSystemInfo } from './hosts.service';

const saved: Host = { id: 'host-1', settings: { name: 'Production', address: 'server.example.com', username: 'admin', port: 22, authentication: { kind: 'keyFile', filename: 'id_ed25519' } } };
const overview: HostOverview = { collectedAt: 1, supported: true, elevated: false, sections: [
  { id: 'system', status: 'ok', truncated: false, output: 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nHostname: ubuntu-server\nKernel: Linux 6.8.0 x86_64 GNU/Linux' },
] };

describe('Hosts', () => {
  let component: Hosts;
  let fixture: ComponentFixture<Hosts>;
  let automation: { latest: ReturnType<typeof vi.fn>; groups: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> };
  let reboots: { preview: ReturnType<typeof vi.fn>; latest: ReturnType<typeof vi.fn>; apply: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> };
  let service: {
    systemInfo: ReturnType<typeof signal<Record<string, HostSystemInfo>>>;
    system: ReturnType<typeof vi.fn>;
    desktop: boolean;
    list: ReturnType<typeof vi.fn>;
    identities: ReturnType<typeof vi.fn>;
    terminals: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    inspect: ReturnType<typeof vi.fn>;
    review: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; operation: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    service = {
      systemInfo: signal<Record<string, HostSystemInfo>>({}),
      system: vi.fn(), review: vi.fn(), start: vi.fn(), operation: vi.fn(),
      desktop: true,
      inspect: vi.fn().mockResolvedValue(overview),
      list: vi.fn().mockResolvedValue([saved]),
      identities: vi.fn().mockResolvedValue({ agentIdentities: [], keyFiles: ['id_ed25519'], agentError: 'No agent', keyError: null }),
      terminals: vi.fn().mockResolvedValue([{ id: 'xterm', label: 'xterm' }]),
      save: vi.fn().mockResolvedValue(saved), delete: vi.fn().mockResolvedValue(undefined), connect: vi.fn().mockResolvedValue(undefined),
    };
    service.system = service.inspect;
    automation = { latest: vi.fn().mockResolvedValue(null), groups: vi.fn().mockResolvedValue([]), save: vi.fn().mockImplementation(async (id, name, memberIds) => ({ id: id ?? 'group-1', name, memberIds })) };
    reboots = { preview: vi.fn(), latest: vi.fn(), apply: vi.fn(), refresh: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [Hosts], providers: [{ provide: RebootsService, useValue: reboots }, provideRouter([]), { provide: HostsService, useValue: service }, { provide: AutomationService, useValue: automation }],
    }).compileComponents();

    vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    fixture = TestBed.createComponent(Hosts);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('edits the remote hostname inline and displays only the verified result', async () => {
    const other = { ...saved, id: 'other' };
    component.hosts.set([saved, other]);
    const results = [saved, other].map(host => ({ host, outcome: 'successful' as const, diagnostics: 'OK' }));
    component.selection.pingResults.set(new Map(results.map(result => [result.host.id, result])));
    const before = component.pingStatuses();
    service.review.mockResolvedValue({ id: 'rename', host: saved });
    service.start.mockResolvedValue({ id: 'rename', hostId: saved.id, state: 'succeeded', logs: 'Ansible OK', overview: {
      ...overview, sections: [{ id: 'system', status: 'ok', truncated: false, output: 'Hostname: web-01' }],
    } });
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[aria-label="Change hostname for Production"]').click();
    await fixture.whenStable(); fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('#hostname-host-1') as HTMLInputElement;
    expect(input.value).toBe('ubuntu-server');
    input.value = 'web-01'; input.dispatchEvent(new Event('input'));
    await component.saveHostname(saved); fixture.detectChanges();
    expect(service.review).toHaveBeenCalledExactlyOnceWith(saved.id, { kind: 'setHostname', hostname: 'web-01' });
    expect(service.start).toHaveBeenCalledTimes(1);
    expect(component.systemInfo()[saved.id].hostname).toBe('web-01');
    expect(component.pingStatuses()).toEqual(before);
    expect(component.selection.pingResults().get(saved.id)).toBe(results[0]);
    expect(component.selection.pingResults().get(other.id)).toBe(results[1]);
    expect(component.hosts()[0].settings).toEqual(saved.settings);
    expect(component.hostnameEdits()[saved.id].editing).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('Hostname changed to web-01.');
    expect(TestBed.inject(Router).navigateByUrl).not.toHaveBeenCalled();
  });

  it('preserves Ping after saving a display name but invalidates changed SSH connections', async () => {
    component.selection.pingResults.set(new Map([[saved.id, { host: saved, outcome: 'successful', diagnostics: 'OK' }]]));
    const renamed = { ...saved, settings: { ...saved.settings, name: 'Renamed server' } };
    service.save.mockResolvedValue(renamed);
    component.edit(saved);
    component.form.controls.name.setValue(renamed.settings.name);
    await component.save();
    expect(component.pingStatuses().get(saved.id)?.outcome).toBe('successful');
    for (const patch of [
      { address: '192.0.2.99' }, { port: 2222 }, { username: 'different' },
      { authentication: { kind: 'keyFile' as const, filename: 'another_key' } },
      { authentication: { kind: 'agent' as const, fingerprint: 'SHA256:another' } },
    ]) {
      component.hosts.set([{ ...renamed, settings: { ...renamed.settings, ...patch } }]);
      expect(component.pingStatuses().get(saved.id)?.outcome).toBe('changed');
    }
  });

  it('rejects invalid hostnames and cancellation without submitting an operation', async () => {
    component.editHostname(saved);
    component.hostnameValue(saved.id, 'bad;hostname');
    await component.saveHostname(saved);
    expect(component.hostnameEdits()[saved.id].error).toContain('lowercase');
    component.cancelHostname(saved.id);
    await component.saveHostname(saved);
    expect(service.review).not.toHaveBeenCalled();
  });

  it('polls without duplicate dispatch and preserves the hostname on an uncertain result', async () => {
    vi.useFakeTimers();
    try {
      service.review.mockResolvedValue({ id: 'rename', host: saved });
      service.start.mockResolvedValue({ id: 'rename', hostId: saved.id, state: 'running' });
      service.operation.mockResolvedValue({ id: 'rename', hostId: saved.id, state: 'unknown', message: 'Refresh before retrying', logs: 'Connection lost' });
      component.editHostname(saved); component.hostnameValue(saved.id, 'web-01');
      const pending = component.saveHostname(saved);
      await component.saveHostname(saved);
      await vi.advanceTimersByTimeAsync(1000); await pending;
      expect(service.start).toHaveBeenCalledTimes(1);
      expect(component.systemInfo()[saved.id].hostname).toBe('ubuntu-server');
      expect(component.hostnameEdits()[saved.id].error).toContain('Refresh before retrying');
      expect(component.hostnameEdits()[saved.id].logs).toBe('Connection lost');
      expect(component.busy()).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('keeps row actions inline and reboots exactly the clicked host after preflight', async () => {
    component.selection.hostIds.set(['other']); component.selection.groupIds.set(['group']);
    const ping = vi.spyOn(component.runner, 'runPing').mockResolvedValue(null);
    const review: RebootRun = { id: 'r1', targetLabel: 'Production', phase: 'review', active: false, stopRequested: false,
      results: [{ host: saved, state: 'ready', message: 'Review ready', logs: '', rebootRequired: true, plan: null }] };
    reboots.preview.mockResolvedValue(review); reboots.apply.mockResolvedValue({ ...review, phase: 'finished' });
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[aria-label="Ping Production"]').click();
    await fixture.whenStable();
    expect(ping).toHaveBeenCalledExactlyOnceWith(saved.id);
    fixture.nativeElement.querySelector('[aria-label="Reboot Production"]').click();
    await fixture.whenStable(); fixture.detectChanges();
    expect(reboots.preview).toHaveBeenCalledExactlyOnceWith({ hostIds: [saved.id], groupIds: [] });
    expect(component.selection.snapshot()).toEqual({ hostIds: ['other'], groupIds: ['group'] });
    expect(TestBed.inject(Router).navigateByUrl).not.toHaveBeenCalled();
    expect(reboots.apply).toHaveBeenCalledExactlyOnceWith('r1');
  });

  it('does not reboot when preflight fails or targets a different host', async () => {
    for (const result of [{ host: saved, state: 'failed' }, { host: { ...saved, id: 'other' }, state: 'ready' }]) {
      reboots.preview.mockResolvedValue({ id: 'review', phase: 'review', active: false, results: [result] });
      await component.quickReboot(saved);
    }
    expect(reboots.apply).not.toHaveBeenCalled();
  });

  it('waits for preflight, ignores duplicate clicks, and never reapplies while polling', async () => {
    vi.useFakeTimers();
    try {
      const review = { id: 'review', phase: 'preview', active: true, results: [{ host: saved, state: 'waiting' }] };
      reboots.preview.mockResolvedValue(review);
      reboots.latest.mockResolvedValue({ ...review, phase: 'review', active: false, results: [{ host: saved, state: 'ready' }] });
      reboots.apply.mockResolvedValue({ ...review, phase: 'apply' });
      const pending = component.quickReboot(saved); await Promise.resolve();
      await component.quickReboot(saved);
      expect(reboots.preview).toHaveBeenCalledTimes(1);
      expect(reboots.apply).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1500); await pending;
      expect(reboots.apply).toHaveBeenCalledExactlyOnceWith('review');
      await component.pollReboot();
      expect(reboots.apply).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('retains other host results during and after a single-host Ping, including navigation', async () => {
    const other = { ...saved, id: 'other' };
    component.hosts.set([saved, other]);
    automation.latest.mockResolvedValue({ id: 'all', active: false, results: [saved, other].map(host => ({ host, outcome: 'successful', diagnostics: 'OK' })) });
    await component.refreshPing();
    const previous = component.pingStatuses().get('other');
    for (const outcome of ['waiting', 'failed']) {
      automation.latest.mockResolvedValue({ id: 'one', active: false, results: [{ host: saved, outcome, diagnostics: 'Changed' }] });
      await component.refreshPing();
      expect(component.pingStatuses().get('other')).toEqual(previous);
      expect(component.pingStatuses().get(saved.id)?.outcome).toBe(outcome);
    }
    fixture.destroy(); fixture = TestBed.createComponent(Hosts); component = fixture.componentInstance;
    await fixture.whenStable(); component.hosts.set([saved, other]);
    expect(component.pingStatuses().get('other')).toEqual(previous);
  });

  it('shows latest Ping outcomes by host ID and invalidates changed settings', async () => {
    const duplicate = { ...saved, id: 'other' };
    component.hosts.set([saved, duplicate]);
    for (const outcome of ['waiting', 'successful', 'unreachable', 'failed', 'cancelled', 'timed-out'] as const) {
      automation.latest.mockResolvedValue({ id: 'run', active: false, results: [{ host: saved, outcome, diagnostics: 'Details' }] });
      await component.refreshPing();
      expect(component.pingStatuses().get(saved.id)?.outcome).toBe(outcome);
      expect(component.pingStatuses().get(duplicate.id)?.outcome).toBe('unchecked');
    }
    component.hosts.set([{ ...saved, settings: { ...saved.settings, port: 2222 } }]);
    expect(component.pingStatuses().get(saved.id)?.outcome).toBe('changed');
  });

  it('polls active runs, reports polling failures, and stops on destroy', async () => {
    vi.useFakeTimers();
    try {
      const run = { id: 'run', active: true, results: [{ host: saved, outcome: 'waiting', diagnostics: '' }] } as PingRun;
      automation.latest.mockResolvedValue(run);
      await component.refreshPing();
      automation.latest.mockRejectedValueOnce('Connection lost');
      await vi.advanceTimersByTimeAsync(1000);
      expect(component.pingStatuses().get(saved.id)?.outcome).toBe('unavailable');
      automation.latest.mockResolvedValue({ ...run, active: false, results: [{ host: saved, outcome: 'successful', diagnostics: 'pong' }] });
      await vi.advanceTimersByTimeAsync(1000);
      expect(component.pingStatuses().get(saved.id)?.label).toBe('Passed');
      expect(component.pingError()).toBe('');
      let finish!: (run: PingRun) => void;
      automation.latest.mockImplementation(() => new Promise<PingRun>(resolve => { finish = resolve; }));
      const pending = component.refreshPing();
      fixture.destroy();
      finish(run);
      await pending;
      expect(component.pingRun()?.active).toBe(false);
      const calls = automation.latest.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2000);
      expect(automation.latest).toHaveBeenCalledTimes(calls);
    } finally { vi.useRealTimers(); }
  });

  it('loads saved hosts and filters by name, address and username', () => {
    expect(component.hosts()).toEqual([saved]);
    component.search.set('ADMIN');
    expect(component.filtered()).toEqual([saved]);
    component.search.set('missing');
    expect(component.filtered()).toEqual([]);
  });

  it('creates a group from row selections including hosts hidden by filters', async () => {
    component.toggleHostSelection(saved.id, true);
    component.search.set('missing');
    component.editGroup();
    component.groupName.set('Selected');
    await component.saveGroup();
    expect(automation.save).toHaveBeenCalledWith(null, 'Selected', [saved.id]);
    expect(component.selectedHostIds()).toEqual([saved.id]);
    expect(component.groupEditing()).toBe(false);
  });

  it('selects and deselects visible hosts without discarding hidden selections', () => {
    const second = { ...saved, id: 'host-2', settings: { ...saved.settings, name: 'Staging' } };
    component.hosts.set([saved, second]);
    component.toggleHostSelection(saved.id, true);
    expect(component.someVisibleSelected()).toBe(true);
    expect(component.allVisibleSelected()).toBe(false);
    component.search.set('Staging');
    component.selectVisible(true);
    expect(component.selectedHostIds()).toEqual([saved.id, second.id]);
    component.selectVisible(false);
    expect(component.selectedHostIds()).toEqual([saved.id]);
    expect(component.hiddenSelectionCount()).toBe(1);
  });

  it('uses row selection to edit membership without changing saved members before save', () => {
    const group = { id: 'group-1', name: 'Servers', memberIds: [saved.id] };
    component.groups.set([group]);
    component.groupId.set(group.id);
    component.search.set('missing');
    component.editGroup(group);
    expect(component.groupId()).toBe('');
    expect(component.search()).toBe('');
    expect(component.groupMembers()).toEqual([saved.id]);
    expect(component.selectedHostIds()).toEqual([]);
    component.toggleHostSelection(saved.id, false);
    expect(component.groups()[0].memberIds).toEqual([saved.id]);
  });

  it('preserves selected rows on failed save and only prunes explicitly deleted hosts', async () => {
    component.toggleHostSelection(saved.id, true);
    component.editGroup();
    component.groupName.set('Servers');
    automation.save.mockRejectedValue('Write failed');
    await component.saveGroup();
    expect(component.selectedHostIds()).toEqual([saved.id]);
    expect(component.groupEditing()).toBe(true);
    await component.remove(saved);
    expect(component.selectedHostIds()).toEqual([]);
    component.selectedHostIds.set(['missing']);
    await component.refresh();
    expect(component.selectedHostIds()).toEqual(['missing']);
  });

  it('filters group intersections without changing session selections', () => {
    const second = { ...saved, id: 'host-2' };
    component.hosts.set([saved, second]);
    component.groups.set([
      { id: 'a', name: 'A', memberIds: [saved.id, second.id] },
      { id: 'b', name: 'B', memberIds: [saved.id] },
    ]);
    component.toggleHostSelection(second.id, true);
    component.selection.selectGroup('a', true);
    component.chooseGroup('a');
    component.overlapId.set('b');
    expect(component.filtered()).toEqual([saved]);
    expect(component.selection.snapshot()).toEqual({ hostIds: [second.id], groupIds: ['a'] });
    component.editGroup(component.groups()[1]);
    component.toggleHostSelection(second.id, true);
    expect(component.groupMembers()).toEqual([saved.id, second.id]);
    expect(component.selection.snapshot()).toEqual({ hostIds: [second.id], groupIds: ['a'] });
  });

  it('copies the exact inventory value and reports clipboard failures honestly', () => {
    const copy = vi.spyOn(TestBed.inject(Clipboard), 'copy').mockReturnValue(true);
    const notification = vi.spyOn(TestBed.inject(MatSnackBar), 'open');
    component.copyInfo(saved, 'Address', saved.settings.address);
    expect(copy).toHaveBeenCalledWith('server.example.com');
    expect(notification).toHaveBeenLastCalledWith('Address copied for Production.', 'Dismiss', { duration: 3000 });
    copy.mockReturnValue(false);
    component.copyInfo(saved, 'Port', 22);
    expect(copy).toHaveBeenLastCalledWith('22');
    expect(notification).toHaveBeenLastCalledWith('Could not copy. Select the value and copy it manually.', 'Dismiss', { duration: 3000 });
  });

  it('shows the inspected OS and kernel without blocking inventory actions', async () => {
    await fixture.whenStable();
    expect(component.systemInfo()[saved.id]).toMatchObject({ name: 'Ubuntu 24.04.1 LTS', hostname: 'ubuntu-server', kernel: 'Linux 6.8.0 x86_64 GNU/Linux', pending: false });
    expect(fixture.nativeElement.querySelector('.os-summary').textContent).toContain('Ubuntu 24.04.1 LTS');
    component.toggleInfo(saved.id); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[aria-label="Copy hostname for Production"]').textContent).toBe('ubuntu-server');
    expect(component.busy()).toBe(false);
  });

  it('retains last known OS on transient errors and recovers on refresh', async () => {
    service.inspect.mockRejectedValueOnce('SSH authentication required.');
    await component.refresh();
    await fixture.whenStable();
    expect(component.systemInfo()[saved.id]).toMatchObject({ name: 'Ubuntu 24.04.1 LTS', hostname: 'ubuntu-server', pending: false, error: 'SSH authentication required.' });
    expect(component.error()).toBe('');
    await component.refresh();
    await fixture.whenStable();
    expect(component.systemInfo()[saved.id].name).toBe('Ubuntu 24.04.1 LTS');
  });

  it('keeps cached OS visible while refreshing and across navigation', async () => {
    let finish!: (value: HostOverview) => void;
    service.inspect.mockImplementationOnce(() => new Promise<HostOverview>(resolve => { finish = resolve; }));
    await component.refresh(); fixture.detectChanges();
    expect(component.systemInfo()[saved.id].pending).toBe(true);
    expect(fixture.nativeElement.querySelector('.os-summary').textContent).toContain('Ubuntu 24.04.1 LTS');
    finish(overview); await fixture.whenStable();
    fixture.destroy();
    fixture = TestBed.createComponent(Hosts); component = fixture.componentInstance;
    expect(component.systemInfo()[saved.id].name).toBe('Ubuntu 24.04.1 LTS');
    await fixture.whenStable();
  });

  it('automatically retries failed OS refreshes without a manual refresh', async () => {
    vi.useFakeTimers();
    try {
      fixture.destroy();
      service.inspect.mockRejectedValueOnce('Temporary SSH failure');
      fixture = TestBed.createComponent(Hosts); component = fixture.componentInstance;
      await component.ngOnInit(); await Promise.resolve();
      expect(component.systemInfo()[saved.id].error).toBe('Temporary SSH failure');
      const calls = service.inspect.mock.calls.length;
      await vi.advanceTimersByTimeAsync(15000);
      expect(service.inspect.mock.calls.length).toBeGreaterThan(calls);
      expect(component.systemInfo()[saved.id].error).toBe('');
    } finally { vi.useRealTimers(); }
  });

  it('does not infer an OS from a missing or failed system section', async () => {
    service.inspect.mockResolvedValue({ ...overview, sections: [{ ...overview.sections[0], status: 'failed' }] });
    await component.refresh();
    await fixture.whenStable();
    expect(component.systemInfo()[saved.id].name).toBe('Ubuntu 24.04.1 LTS');
    expect(component.systemInfo()[saved.id].error).toContain('unavailable');
  });

  it('limits concurrent inspections and discards responses after host removal', async () => {
    const finish: ((value: HostOverview) => void)[] = [];
    service.inspect.mockClear().mockImplementation(() => new Promise<HostOverview>(resolve => finish.push(resolve)));
    const hosts = [saved, { ...saved, id: 'host-2' }, { ...saved, id: 'host-3' }];
    service.list.mockResolvedValue(hosts);
    await component.refresh();
    expect(service.inspect).toHaveBeenCalledTimes(3);
    expect(component.busy()).toBe(false);
    await component.remove(saved);
    finish[0](overview);
    await fixture.whenStable();
    expect(component.systemInfo()[saved.id]).toBeUndefined();
    expect(service.inspect).toHaveBeenCalledTimes(3);
    fixture.destroy();
    finish[1](overview);
    finish[2](overview);
    await Promise.resolve();
    expect(component.systemInfo()['host-2'].pending).toBe(true);
  });

  it('ignores an old inspection when the saved connection changes', async () => {
    let finish!: (value: HostOverview) => void;
    service.inspect.mockImplementationOnce(() => new Promise<HostOverview>(resolve => { finish = resolve; }));
    await component.refresh();
    component.edit(saved);
    const changed = { ...saved, settings: { ...saved.settings, address: 'new.example.com' } };
    service.save.mockResolvedValue(changed);
    service.inspect.mockResolvedValue({ ...overview, sections: [{ ...overview.sections[0], output: 'PRETTY_NAME="Debian GNU/Linux 13"' }] });
    await component.save();
    await fixture.whenStable();
    finish(overview);
    await fixture.whenStable();
    expect(component.systemInfo()[saved.id].name).toBe('Debian GNU/Linux 13');
  });

  it('saves metadata and the selected key reference only', async () => {
    component.edit();
    component.form.setValue({ name: 'Production', address: 'server.example.com', username: 'admin', port: 22, kind: 'keyFile', identity: 'id_ed25519' });
    await component.save();
    expect(service.save).toHaveBeenCalledWith(null, saved.settings);
    expect(component.editing()).toBe(false);
    expect(component.status()).toBe('Host saved.');
  });

  it('keeps the edit form and inventory when a save fails', async () => {
    service.save.mockRejectedValue('Inventory is busy.');
    component.edit(saved);
    component.form.controls.port.setValue(2222);
    await component.save();
    expect(component.error()).toBe('Inventory is busy.');
    expect(component.editing()).toBe(true);
    expect(component.hosts()[0].settings.port).toBe(22);
  });

  it('rejects invalid form values before invoking native commands', async () => {
    component.edit(saved);
    component.form.controls.port.setValue(0);
    await component.save();
    expect(service.save).not.toHaveBeenCalled();
  });

  it('launches by saved ID and reports no authentication claim', async () => {
    await component.connect(saved);
    expect(service.connect).toHaveBeenCalledWith(saved.id, 'xterm');
    expect(component.status()).toContain('Terminal launched');
    expect(component.status()).not.toContain('Connected');
    service.connect.mockRejectedValue('Selected identity is unavailable.');
    await component.connect(saved);
    expect(component.error()).toContain('unavailable');
    expect(component.status()).toBe('');
  });

  it('prevents duplicate commands while a launch is pending', async () => {
    let finish!: () => void;
    service.connect.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = component.connect(saved);
    await component.connect(saved);
    expect(service.connect).toHaveBeenCalledTimes(1);
    finish();
    await first;
    expect(component.busy()).toBe(false);
  });

  it('retains unavailable identity references when editing', () => {
    component.identities.set({ agentIdentities: [], keyFiles: [], agentError: null, keyError: null });
    component.edit(saved);
    expect(component.identityUnavailable()).toBe(true);
    expect(component.form.controls.identity.value).toBe('id_ed25519');
  });

  it('removes the host only after successful native deletion', async () => {
    service.delete.mockRejectedValueOnce('Write failed.');
    component.deleting.set(saved);
    await component.remove(saved);
    expect(component.hosts()).toEqual([saved]);
    expect(component.deleting()).toEqual(saved);
    await component.remove(saved);
    expect(component.hosts()).toEqual([]);
    expect(component.deleting()).toBeNull();
  });

  it('does not invoke native operations in the browser', async () => {
    fixture.destroy();
    service.desktop = false;
    service.list.mockClear();
    fixture = TestBed.createComponent(Hosts);
    await fixture.whenStable();
    expect(service.list).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Open Admin-Tower for Linux');
    expect(fixture.nativeElement.querySelector('form')).toBeNull();
  });
});
