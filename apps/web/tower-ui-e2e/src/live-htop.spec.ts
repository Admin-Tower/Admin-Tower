import { expect, test } from '@playwright/test';

test('renders streaming htop, forwards controls, resizes and stops on navigation', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    let starts = 0, polls = 0;
    const inputs: string[] = [], stops: string[] = [], sizes: unknown[] = [];
    const host = { id: 'live-host', settings: { name: 'Debian live host', address: 'server.example.com', username: 'admin', port: 22, authentication: { kind: 'agent', fingerprint: 'SHA256:fixture' } } };
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { invoke: async (command: string, args: { sessionId: string; data: string }) => {
      if (command === 'list_hosts') return [host];
      if (command === 'list_terminals') return [{ id: 'xterm', label: 'xterm' }];
      if (command === 'inspect_host') return { supported: true, elevated: false, collectedAt: 1789800000, sections: [{ id: 'processes', status: 'ok', truncated: false, output: '1 0 root 0.1 0.2 S init' }] };
      if (command === 'start_htop') { polls = 0; return 'live-' + (++starts); }
      if (command === 'poll_htop') {
        polls++;
        return { data: btoa('\x1b[H\x1b[2J\x1b[32mCPU [||||      34%]\x1b[0m\r\nMemory [|||||    1.2G/4G]\r\nTasks: 42, 1 running\r\nPID USER   CPU%  MEM% Command\r\n  1 root    0.1   0.2 init\r\n 23 admin  34.0   2.4 worker\r\nFrame ' + polls), ended: false, message: 'Session active · read-only htop' };
      }
      if (command === 'input_htop') { inputs.push(args.data); sessionStorage.setItem('htop-inputs', JSON.stringify(inputs)); return; }
      if (command === 'resize_htop') { sizes.push(args); sessionStorage.setItem('htop-sizes', JSON.stringify(sizes)); return; }
      if (command === 'stop_htop') { stops.push(args.sessionId); sessionStorage.setItem('htop-stops', JSON.stringify(stops)); return; }
      throw new Error('Unexpected command: ' + command);
    } } });
  });
  await page.goto('/hosts/live-host');
  await page.getByRole('button', { name: 'Processes', exact: true }).click();
  const view = page.getByRole('region', { name: 'Live htop', exact: true });
  await expect(view.getByRole('status')).toHaveText('Not connected');
  await view.getByRole('button', { name: 'Start live htop', exact: true }).click();
  await expect(view.locator('.xterm-accessibility')).toContainText('Tasks: 42');
  await expect(view.getByRole('status')).toContainText('Session active');
  await view.getByRole('button', { name: 'Tree / list', exact: true }).click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('htop-inputs'))).toContain('"t"');
  await view.locator('.xterm-helper-textarea').press('ArrowDown');
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('htop-inputs') ?? '[]').length)).toBeGreaterThan(1);
  await page.screenshot({ path: testInfo.outputPath('live-htop-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 540, height: 820 });
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('htop-sizes') ?? '[]').length)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('live-htop-narrow.png'), fullPage: true });
  await view.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(view.getByRole('status')).toHaveText('Session stopped');
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('htop-stops'))).toContain('live-1');
  await view.getByRole('button', { name: 'Start live htop', exact: true }).click();
  await expect(view.getByRole('status')).toContainText('Session active');
  await page.getByRole('button', { name: 'Firewall', exact: true }).click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('htop-stops'))).toContain('live-2');
  expect(errors).toEqual([]);
});
