import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Clipboard } from '@angular/cdk/clipboard';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Hosts } from './hosts';
import { Host, HostOverview, HostsService } from './hosts.service';

const saved: Host = { id: 'host-1', settings: { name: 'Production', address: 'server.example.com', username: 'admin', port: 22, authentication: { kind: 'keyFile', filename: 'id_ed25519' } } };
const overview: HostOverview = { collectedAt: 1, supported: true, elevated: false, sections: [
  { id: 'system', status: 'ok', truncated: false, output: 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nKernel: Linux 6.8.0 x86_64 GNU/Linux' },
] };

describe('Hosts', () => {
  let component: Hosts;
  let fixture: ComponentFixture<Hosts>;
  let service: {
    desktop: boolean;
    list: ReturnType<typeof vi.fn>;
    identities: ReturnType<typeof vi.fn>;
    terminals: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    inspect: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    service = {
      desktop: true,
      inspect: vi.fn().mockResolvedValue(overview),
      list: vi.fn().mockResolvedValue([saved]),
      identities: vi.fn().mockResolvedValue({ agentIdentities: [], keyFiles: ['id_ed25519'], agentError: 'No agent', keyError: null }),
      terminals: vi.fn().mockResolvedValue([{ id: 'xterm', label: 'xterm' }]),
      save: vi.fn().mockResolvedValue(saved), delete: vi.fn().mockResolvedValue(undefined), connect: vi.fn().mockResolvedValue(undefined),
    };
    await TestBed.configureTestingModule({
      imports: [Hosts], providers: [provideRouter([]), { provide: HostsService, useValue: service }],
    }).compileComponents();

    fixture = TestBed.createComponent(Hosts);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('loads saved hosts and filters by name, address and username', () => {
    expect(component.hosts()).toEqual([saved]);
    component.search.set('ADMIN');
    expect(component.filtered()).toEqual([saved]);
    component.search.set('missing');
    expect(component.filtered()).toEqual([]);
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
    expect(component.systemInfo()[saved.id]).toMatchObject({ name: 'Ubuntu 24.04.1 LTS', kernel: 'Linux 6.8.0 x86_64 GNU/Linux', pending: false });
    expect(fixture.nativeElement.querySelector('.os-summary').textContent).toContain('Ubuntu 24.04.1 LTS');
    expect(component.busy()).toBe(false);
  });

  it('reports unavailable OS data and recovers on refresh', async () => {
    service.inspect.mockRejectedValueOnce('SSH authentication required.');
    await component.refresh();
    await fixture.whenStable();
    expect(component.systemInfo()[saved.id]).toMatchObject({ name: '', pending: false, error: 'SSH authentication required.' });
    expect(component.error()).toBe('');
    await component.refresh();
    await fixture.whenStable();
    expect(component.systemInfo()[saved.id].name).toBe('Ubuntu 24.04.1 LTS');
  });

  it('does not infer an OS from a missing or failed system section', async () => {
    service.inspect.mockResolvedValue({ ...overview, sections: [{ ...overview.sections[0], status: 'failed' }] });
    await component.refresh();
    await fixture.whenStable();
    expect(component.systemInfo()[saved.id].name).toBe('');
    expect(component.systemInfo()[saved.id].error).toContain('unavailable');
  });

  it('limits concurrent inspections and discards responses after host removal', async () => {
    const finish: ((value: HostOverview) => void)[] = [];
    service.inspect.mockClear().mockImplementation(() => new Promise<HostOverview>(resolve => finish.push(resolve)));
    const hosts = [saved, { ...saved, id: 'host-2' }, { ...saved, id: 'host-3' }];
    service.list.mockResolvedValue(hosts);
    await component.refresh();
    expect(service.inspect).toHaveBeenCalledTimes(2);
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
