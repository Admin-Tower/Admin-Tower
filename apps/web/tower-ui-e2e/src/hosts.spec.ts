import { expect, test } from '@playwright/test';

test('browser clearly requires the Linux desktop app', async ({ page }) => {
  await page.goto('/hosts');
  await expect(page.getByRole('heading', { name: 'Open Admin-Tower for Linux' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add host', exact: true })).toHaveCount(0);
});

test.describe('inventory with mocked native IPC', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      type Host = { id: string; settings: { name: string; address: string; username: string; port: number; authentication: { kind: string; filename?: string; fingerprint?: string } } };
      Object.assign(window, {
        isTauri: true,
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: { id?: string; settings?: Host['settings']; terminal?: string } = {}) => {
            const hosts: Host[] = JSON.parse(localStorage.getItem('test-hosts') ?? '[]');
            switch (command) {
              case 'list_hosts': return hosts;
              case 'list_identities': return { agentIdentities: [], keyFiles: ['id_ed25519'], agentError: 'No SSH agent is available.', keyError: null };
              case 'list_terminals': return [{ id: 'xterm', label: 'xterm' }];
              case 'inspect_host':
                if (args.id === 'staging') throw new Error('SSH authentication required.');
                return { collectedAt: 1, supported: true, elevated: false, sections: [
                  { id: 'system', status: 'ok', truncated: false, output: 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nKernel: Linux 6.8.0 x86_64 GNU/Linux' },
                ] };
              case 'save_host': {
                if (!args.settings) throw new Error('Missing settings');
                const host = { id: args.id ?? crypto.randomUUID(), settings: args.settings };
                localStorage.setItem('test-hosts', JSON.stringify([...hosts.filter(h => h.id !== host.id), host]));
                return host;
              }
              case 'delete_host': localStorage.setItem('test-hosts', JSON.stringify(hosts.filter(h => h.id !== args.id))); return;
              case 'connect_host':
                if (localStorage.getItem('test-launch-error')) throw new Error('The selected key is unavailable.');
                if (Object.keys(args).sort().join(',') !== 'id,terminal') throw new Error('Unexpected connection arguments');
                return;
              default: throw new Error(`Unexpected native command: ${command}`);
            }
          },
        },
      });
    });
    await page.goto('/hosts');
  });

  test('adds, persists, filters, edits, launches and confirms deletion', async ({ page }, testInfo) => {
    await page.getByRole('button', { name: 'Add host', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Production');
    await page.getByRole('textbox', { name: 'Hostname or IP address' }).fill('server.example.com');
    await page.getByRole('textbox', { name: 'SSH username' }).fill('admin');
    await page.getByRole('combobox', { name: 'Authentication', exact: true }).click();
    await page.getByRole('option', { name: 'Key file in ~/.ssh' }).click();
    await page.getByRole('combobox', { name: 'Key file', exact: true }).click();
    await page.getByRole('option', { name: 'id_ed25519', exact: true }).click();
    await page.getByRole('button', { name: 'Save host', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Host saved.');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Production', exact: true })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search hosts' }).fill('missing');
    await expect(page.getByRole('heading', { name: 'No matching hosts' })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search hosts' }).fill('');
    await page.getByRole('button', { name: 'Edit Production', exact: true }).click();
    await page.getByRole('spinbutton', { name: 'Port' }).fill('2222');
    await page.getByRole('button', { name: 'Save host', exact: true }).click();
    await expect(page.locator('.host-identity .endpoint')).toHaveText('admin@server.example.com');
    await expect(page.locator('.host-port')).toHaveText('Port 2222');
    await page.screenshot({ path: testInfo.outputPath('hosts.png'), fullPage: true });
    await page.getByRole('button', { name: 'Open terminal for Production' }).click();
    await expect(page.getByRole('status')).toContainText('Terminal launched for Production');
    await page.evaluate(() => localStorage.setItem('test-launch-error', '1'));
    await page.getByRole('button', { name: 'Open terminal for Production' }).click();
    await expect(page.getByRole('alert')).toHaveText('The selected key is unavailable.');
    await page.getByRole('button', { name: 'Delete Production', exact: true }).click();
    await page.getByRole('button', { name: 'Keep host', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Production', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Delete Production', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'No hosts yet' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'No hosts yet' })).toBeVisible();
  });

  test('shows quick info and icon shortcuts in cards and a responsive list', async ({ page, browserName }, testInfo) => {
    await page.evaluate(() => localStorage.setItem('test-hosts', JSON.stringify([
      { id: 'production', settings: { name: 'Production', address: 'server.example.com', username: 'admin', port: 2222, authentication: { kind: 'keyFile', filename: 'id_ed25519' } } },
      { id: 'staging', settings: { name: 'Staging', address: 'staging.example.com', username: 'deploy', port: 22, authentication: { kind: 'agent', fingerprint: 'SHA256:example-agent-fingerprint' } } },
      { id: 'database', settings: { name: 'Database', address: '2001:db8::42', username: 'postgres', port: 22, authentication: { kind: 'keyFile', filename: 'database_ed25519' } } },
    ])));
    await page.reload();
    const inventory = page.getByRole('list', { name: 'Saved hosts' });
    await expect(page.getByRole('button', { name: 'List', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Cards', exact: true }).click();
    await expect(inventory.getByRole('listitem')).toHaveCount(3);
    const production = inventory.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Production', exact: true }) });
    await expect(production.locator('.os-summary')).toContainText('Ubuntu 24.04.1 LTS');
    if (browserName === 'chromium') {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await production.getByRole('button', { name: 'Copy address for Production', exact: true }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('server.example.com');
      await expect(page.getByText('Address copied for Production.', { exact: true })).toBeVisible();
      await production.getByRole('button', { name: 'Copy port for Production', exact: true }).focus();
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('2222');
    }
    await expect(inventory.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Staging', exact: true }) }).locator('.os-summary')).toContainText('OS unavailable');
    const infoToggle = production.getByRole('button', { name: 'Quick info for Production', exact: true });
    const collapsedPosition = await infoToggle.boundingBox();
    await infoToggle.click();
    const expandedPosition = await infoToggle.boundingBox();
    expect(expandedPosition?.x).toBe(collapsedPosition?.x);
    expect(expandedPosition?.y).toBe(collapsedPosition?.y);
    await expect(production.getByText('Linux 6.8.0 x86_64 GNU/Linux', { exact: true })).toBeVisible();
    if (browserName === 'chromium') {
      await production.getByRole('button', { name: 'Copy kernel for Production', exact: true }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Linux 6.8.0 x86_64 GNU/Linux');
      await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    }
    await expect(production.getByText('~/.ssh/id_ed25519', { exact: true })).toBeVisible();
    for (const [label, tab] of [['Overview', 'system'], ['Services', 'services'], ['Processes', 'processes'], ['Accounts', 'accounts']]) {
      await expect(production.getByRole('link', { name: `${label} for Production` })).toHaveAttribute('href', `/hosts/production?tab=${tab}`);
    }
    await page.screenshot({ path: testInfo.outputPath('inventory-cards.png'), fullPage: true });
    await page.getByRole('button', { name: 'List', exact: true }).click();
    await expect(inventory).not.toHaveClass(/card-view/);
    await expect(production.getByText('~/.ssh/id_ed25519', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await production.getByRole('button', { name: 'Open terminal for Production' }).scrollIntoViewIfNeeded();
    await expect(production.getByRole('button', { name: 'Open terminal for Production' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('inventory-mobile.png'), fullPage: true });
    await production.getByRole('button', { name: 'Open terminal for Production' }).click();
    await expect(page.getByRole('status')).toContainText('Terminal launched for Production');
  });
});
