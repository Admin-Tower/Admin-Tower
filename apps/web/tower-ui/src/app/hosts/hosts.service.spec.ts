import { invoke, isTauri } from '@tauri-apps/api/core';
import { HostsService } from './hosts.service';

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

  it('sends only the saved ID and supported terminal selection when connecting', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const service = new HostsService();
    await service.connect('host-id', 'xterm');
    expect(invoke).toHaveBeenCalledExactlyOnceWith('connect_host', { id: 'host-id', terminal: 'xterm' });
  });
});
