import { TestBed } from '@angular/core/testing';
import { LiveHtop } from './live-htop';
import { Host, HostsService } from '../../hosts/hosts.service';
const terminalState = vi.hoisted(() => ({ input: (_data: string) => { /* replaced by onData */ } }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100; rows = 28; options = { disableStdin: true };
    parser = { registerOscHandler: vi.fn() };
    loadAddon() { /* mock addon */ }
    open() { /* mock canvas */ }
    focus() { /* mock focus */ }
    dispose() { /* mock cleanup */ }
    resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; }
    onData(callback: (data: string) => void) { terminalState.input = callback; }
    write(_data: Uint8Array, done: () => void) { done(); }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions() { return { cols: 100, rows: 28 }; } } }));
const host: Host = { id: 'one', settings: { name: 'Host', address: 'example.com', port: 22, username: 'admin', authentication: { kind: 'keyFile', filename: 'id_ed25519' } } };
describe('Live htop', () => {
  let service: { desktop: boolean; startHtop: ReturnType<typeof vi.fn>; pollHtop: ReturnType<typeof vi.fn>; inputHtop: ReturnType<typeof vi.fn>; resizeHtop: ReturnType<typeof vi.fn>; stopHtop: ReturnType<typeof vi.fn> };
  beforeEach(async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.stubGlobal('ResizeObserver', class { observe() { /* mock observer */ } disconnect() { /* mock cleanup */ } });
    service = { desktop: true, startHtop: vi.fn().mockResolvedValue('session'), pollHtop: vi.fn().mockResolvedValue({ data: '', ended: false, message: 'Session active' }), inputHtop: vi.fn().mockResolvedValue(undefined), resizeHtop: vi.fn().mockResolvedValue(undefined), stopHtop: vi.fn().mockResolvedValue(undefined) };
    await TestBed.configureTestingModule({ imports: [LiveHtop], providers: [{ provide: HostsService, useValue: service }] }).compileComponents();
  });
  afterEach(() => vi.unstubAllGlobals());
  function setup() { const fixture = TestBed.createComponent(LiveHtop); fixture.componentRef.setInput('host', host); fixture.detectChanges(); return fixture; }
  it('requires explicit start and sends only bounded terminal input', async () => {
    const fixture = setup(), view = fixture.componentInstance;
    expect(service.startHtop).not.toHaveBeenCalled();
    await view.start(); expect(service.startHtop).toHaveBeenCalledWith('one', 100, 28);
    terminalState.input('t'); expect(service.inputHtop).toHaveBeenCalledWith('session', 't');
    terminalState.input('x'.repeat(1025)); expect(service.inputHtop).toHaveBeenCalledTimes(1);
    await view.stop(); expect(service.stopHtop).toHaveBeenCalledWith('session');
    fixture.destroy();
  });
  it('closes a session that finishes opening after cancellation', async () => {
    let resolve!: (id: string) => void;
    service.startHtop.mockImplementation(() => new Promise<string>(done => { resolve = done; }));
    const fixture = setup(), view = fixture.componentInstance;
    const opening = view.start(); await vi.waitFor(() => expect(service.startHtop).toHaveBeenCalled());
    await view.stop(); resolve('late'); await opening;
    expect(service.stopHtop).toHaveBeenCalledWith('late'); expect(view.session()).toBeNull();
    fixture.destroy();
  });
  it('stops on host changes and on destruction', async () => {
    const fixture = setup(), view = fixture.componentInstance;
    await view.start();
    fixture.componentRef.setInput('host', { ...host, settings: { ...host.settings, address: 'changed.example.com' } });
    await fixture.whenStable(); expect(service.stopHtop).toHaveBeenCalledWith('session');
    await view.start(); fixture.destroy();
    expect(service.stopHtop).toHaveBeenCalledTimes(2);
  });
  it('reports startup failure without starting a polling loop', async () => {
    service.startHtop.mockRejectedValue('Selected identity unavailable');
    const fixture = setup(), view = fixture.componentInstance; await view.start();
    expect(view.error()).toContain('identity unavailable'); expect(service.pollHtop).not.toHaveBeenCalled();
    fixture.destroy();
  });
});
