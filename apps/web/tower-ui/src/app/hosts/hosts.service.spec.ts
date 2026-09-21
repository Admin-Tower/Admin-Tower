import { invoke, isTauri } from '@tauri-apps/api/core';
import { HostsService, Host, HostOverview } from './hosts.service';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));

describe('HostsService native boundary', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('rejects browser operations without attempting IPC', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    const service = new HostsService();
    await expect(service.list()).rejects.toThrow('Linux desktop');
    await expect(service.connect('host-id', 'xterm')).rejects.toThrow('Linux desktop');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('deduplicates simultaneous OS queries for the same saved connection', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    let finish!: (value: HostOverview) => void;
    vi.mocked(invoke).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const host: Host = { id: 'host-id', settings: { name: 'Host', address: '192.0.2.1', port: 22, username: 'root', authentication: { kind: 'keyFile', filename: 'key' } } };
    const service = new HostsService();
    const first = service.system(host);
    const second = service.system({ ...host });
    expect(first).toBe(second);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('host_system_info', { id: host.id });
    finish({ collectedAt: 1, elevated: false, supported: true, sections: [] });
    await first;
    service.system(host);
    expect(invoke).toHaveBeenCalledTimes(2);
    finish({ collectedAt: 2, elevated: false, supported: true, sections: [] });
  });

  it('sends only the saved ID and supported terminal selection when connecting', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const service = new HostsService();
    await service.connect('host-id', 'xterm');
    expect(invoke).toHaveBeenCalledExactlyOnceWith('connect_host', { id: 'host-id', terminal: 'xterm' });
  });
});
