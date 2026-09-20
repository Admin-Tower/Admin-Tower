import { expect, test } from '@playwright/test';

test('host detail reviews actions, refreshes results and keeps firewall read-only', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const host = { id: 'fixture', settings: { name: 'Debian server', address: 'debian.example.com', username: 'admin', port: 22, authentication: { kind: 'keyFile', filename: 'id_ed25519' } } };
    const snapshot = { collectedAt: 1789800000, supported: true, elevated: false, sections: [
      { id: 'system', status: 'ok', output: 'PRETTY_NAME="Debian GNU/Linux"\nID=debian\nHostname: fixture\nUptime: up 3 days\nLogical CPUs: 4\nLoad: 0.10 0.20 0.30', truncated: false },
      { id: 'processes', status: 'ok', output: Array.from({ length: 62 }, (_, i) => `${i + 1} 1 user${i % 2} ${i + 1}.0 1.0 ${i % 2 ? 'S' : 'R'} process-${i + 1}`).join('\n'), truncated: false },
      { id: 'cpu', status: 'ok', output: 'Architecture: x86_64', truncated: false },
      { id: 'users', status: 'ok', output: 'admin:1000:1000::/home/admin:/bin/bash', truncated: false },
      { id: 'groups', status: 'ok', output: 'ops:1001:admin', truncated: false },
      { id: 'serviceFiles', status: 'ok', output: 'ssh.service enabled enabled', truncated: false },
      { id: 'services', status: 'ok', output: 'ssh.service loaded active running OpenSSH', truncated: false },
      { id: 'nftables', status: 'denied', output: 'Operation not permitted', truncated: false },
      { id: 'ufw', status: 'unavailable', output: 'ufw not installed', truncated: false },
    ] };
    let current: { kind: string; username?: string; unit?: string; verb?: string } | undefined;
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        const calls = JSON.parse(sessionStorage.getItem('calls') ?? '[]');
        calls.push({ command, args }); sessionStorage.setItem('calls', JSON.stringify(calls));
        switch (command) {
          case 'list_hosts': return [host];
          case 'list_host_groups': return [];
          case 'latest_ping': return null;
          case 'list_identities': return { agentIdentities: [], keyFiles: ['id_ed25519'], agentError: null, keyError: null };
          case 'list_terminals': return [{ id: 'xterm', label: 'xterm' }];
          case 'inspect_host': return snapshot;
          case 'review_host_action':
            current = args['action'] as typeof current;
            return { id: 'review-1', host, summary: current?.kind === 'service' ? `${current.verb} ${current.unit}` : `Create user ${current?.username}`, command: current?.kind === 'service' ? `systemctl ${current.verb} -- '${current.unit}'` : `useradd -m -U -- '${current?.username}'`, warning: 'Review carefully; authentication takes place in the terminal.', expiresAt: Date.now() / 1000 + 300 };
          case 'start_host_action': return { id: 'review-1', hostId: host.id, state: 'running', message: 'Complete authentication in the external terminal.', overview: null };
          case 'get_host_operation':
            if (current?.kind === 'service') return { id: 'review-1', hostId: host.id, state: 'unknown', message: 'Connection interrupted. Refresh before another action.', overview: null };
            return { id: 'review-1', hostId: host.id, state: 'succeeded', message: 'Operation completed; host information refreshed.', overview: { ...snapshot, elevated: true, sections: snapshot.sections.map(s => s.id === 'users' ? { ...s, output: s.output + '\nalice:1002:1002::/home/alice:/bin/bash' } : s) } };
          default: throw new Error(`Unexpected command ${command}`);
        }
      },
    } });
  });
  await page.goto('/hosts');
  await page.getByRole('link', { name: 'Debian server', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Debian server', exact: true })).toBeVisible();
  await expect(page.locator('summary').filter({ hasText: 'Operating system & resources details' })).toBeVisible();
  await expect(page.locator('pre:visible')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('host-overview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Users & groups', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Users', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'New username', exact: true })).not.toBeVisible();
  await page.locator('#account-editor > summary').click();
  await page.getByRole('textbox', { name: 'New username', exact: true }).fill('alice');
  await page.getByRole('button', { name: 'Review user creation' }).click();
  await expect(page.getByRole('heading', { name: 'Review: Create user alice' })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('calls') ?? '[]').filter((c: {command: string}) => c.command === 'start_host_action').length)).toBe(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Confirm and open terminal' }).click();
  await expect(page.getByRole('status')).toContainText('Operation completed');
  await expect(page.getByRole('table', { name: 'Users', exact: true }).getByRole('cell', { name: 'alice', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Firewall', exact: true }).click();
  await expect(page.getByText('Permission required', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Not installed', { exact: true }).first()).toBeVisible();
  await expect(page.locator('form')).toHaveCount(0);
  await page.getByRole('button', { name: 'Services', exact: true }).click();
  await page.getByRole('table', { name: 'Loaded services', exact: true }).getByRole('button', { name: 'Manage ssh.service', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Service', exact: true })).toHaveValue('ssh.service');
  await page.getByRole('button', { name: 'Review service change' }).click();
  await expect(page.getByRole('heading', { name: 'Review: restart ssh.service' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm and open terminal' }).click();
  await expect(page.getByRole('status')).toContainText('Connection interrupted');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('calls') ?? '[]').filter((c: {command: string}) => c.command === 'start_host_action').length)).toBe(2);
  await page.getByRole('button', { name: 'Processes', exact: true }).click();
  const table = page.getByRole('table', { name: 'Processes', exact: true });
  await expect(table.locator('tbody tr')).toHaveCount(25);
  await expect(table.locator('tbody tr').first().locator('td').first()).toHaveText('62');
  await table.getByRole('button', { name: 'Sort by PID', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(table.locator('th').first()).toHaveAttribute('aria-sort', 'ascending');
  await expect(table.locator('tbody tr').nth(1).locator('td').first()).toHaveText('2');
  await page.getByRole('searchbox', { name: 'Search Processes', exact: true }).fill('process-62');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search Processes', exact: true }).fill('no-such-process');
  await expect(page.getByText('No records match your filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByRole('combobox', { name: 'Filter Processes by State', exact: true }).selectOption('S');
  await expect(page.getByText('1–25 of 31 (62 total)', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByRole('combobox', { name: 'Rows per page', exact: true }).selectOption({ label: '50' });
  await page.getByRole('button', { name: 'Next page of Processes', exact: true }).click();
  await expect(table.locator('tbody tr')).toHaveCount(12);
  await page.getByRole('button', { name: 'Previous page of Processes', exact: true }).click();
  await page.getByRole('heading', { name: 'Processes', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('host-processes.png'), fullPage: true });
  await page.setViewportSize({ width: 540, height: 820 });
  await expect(page.getByRole('button', { name: 'Toggle sidenav', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('heading', { name: 'Processes', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('searchbox', { name: 'Search Processes', exact: true })).toBeVisible();
  const region = page.getByRole('region', { name: 'Processes results', exact: true });
  expect(await region.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('host-processes-narrow.png'), fullPage: true });

});
