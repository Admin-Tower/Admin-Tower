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
    await page.getByRole('textbox', { name: 'Search hosts' }).fill('missing');
    await expect(page.getByText('No hosts match your search.')).toBeVisible();
    await page.getByRole('textbox', { name: 'Search hosts' }).fill('');
    await page.getByRole('button', { name: 'Edit Production', exact: true }).click();
    await page.getByRole('spinbutton', { name: 'Port' }).fill('2222');
    await page.getByRole('button', { name: 'Save host', exact: true }).click();
    await expect(page.getByText('admin@server.example.com · Port 2222')).toBeVisible();
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
});
