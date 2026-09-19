import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Hosts } from './hosts';
import { Host, HostsService } from './hosts.service';

const saved: Host = { id: 'host-1', settings: { name: 'Production', address: 'server.example.com', username: 'admin', port: 22, authentication: { kind: 'keyFile', filename: 'id_ed25519' } } };

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
  };

  beforeEach(async () => {
    service = {
      desktop: true,
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
