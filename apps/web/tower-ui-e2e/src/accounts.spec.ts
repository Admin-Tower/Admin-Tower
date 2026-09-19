import { expect, test } from '@playwright/test';

test('explores primary and supplementary memberships and reviews contextual changes', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const host = { id: 'accounts-host', settings: { name: 'Debian server', username: 'admin', address: 'server.example.com', port: 22, authentication: { kind: 'keyFile', filename: 'id_ed25519' } } };
    const sections = [
      { id: 'users', status: 'ok', truncated: false, output: 'root:0:0:Root:/root:/bin/bash\nalice:1000:1000:Alice Smith:/home/alice:/bin/bash\nworker:101:1001:Service account:/srv/worker:/usr/sbin/nologin' },
      { id: 'groups', status: 'ok', truncated: false, output: 'root:0:\nalice:1000:\nops:1001:alice,external\naudit:1002:' },
    ];
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { invoke: async (command: string, args: { action?: unknown }) => {
      if (command === 'list_hosts') return [host];
      if (command === 'list_terminals') return [{ id: 'xterm', label: 'xterm' }];
      if (command === 'inspect_host') return { supported: true, elevated: false, collectedAt: 1789800000, sections };
      if (command === 'review_host_action') {
        sessionStorage.setItem('reviewed-account-action', JSON.stringify(args.action));
        return { id: 'review', host, summary: 'Membership change', command: 'Reviewed membership command', warning: 'Changes supplementary membership', expiresAt: 9999999999 };
      }
      sessionStorage.setItem('unexpected-account-command', command);
      throw new Error('Unexpected native command');
    } } });
  });
  await page.goto('/hosts/accounts-host');
  await page.getByRole('button', { name: 'Users & groups', exact: true }).click();
  const view = page.getByRole('region', { name: 'Users and groups explorer', exact: true });
  await expect(view.getByRole('table', { name: 'Users', exact: true }).locator('tbody tr')).toHaveCount(3);
  await view.getByRole('searchbox', { name: 'Search users', exact: true }).fill('ops');
  await expect(view.getByRole('table').locator('tbody tr')).toHaveCount(2);
  await view.getByRole('table').getByRole('button', { name: 'alice', exact: true }).click();
  const user = view.getByRole('complementary', { name: 'User details' });
  await expect(user.getByRole('heading', { name: 'Primary group · GID 1000' })).toBeVisible();
  await expect(user.getByRole('heading', { name: 'Supplementary groups · 1' })).toBeVisible();
  await expect(user.getByRole('button', { name: 'Review removing alice from alice', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('account-memberships.png'), fullPage: true });
  await user.getByRole('combobox', { name: 'Add to supplementary group' }).selectOption('audit');
  await user.getByRole('button', { name: 'Review addition', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review: Membership change' })).toBeFocused();
  expect(JSON.parse(await page.evaluate(() => sessionStorage.getItem('reviewed-account-action')) ?? '{}')).toEqual({ kind: 'membership', username: 'alice', group: 'audit', add: true });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await user.getByRole('button', { name: 'ops', exact: true }).click();
  const group = view.getByRole('complementary', { name: 'Group details' });
  await expect(group.getByRole('heading', { name: 'Primary members · 1' })).toBeVisible();
  await expect(group.getByText('external · account not captured', { exact: true })).toBeVisible();
  await expect(group.getByRole('button', { name: 'Review removing external from ops' })).toBeDisabled();
  await group.getByRole('button', { name: 'worker', exact: true }).click();
  await expect(user.getByText('/usr/sbin/nologin', { exact: true })).toBeVisible();
  await view.getByRole('button', { name: 'Close details', exact: true }).click();
  await view.getByRole('button', { name: 'Groups (4)', exact: true }).click();
  await view.getByRole('combobox', { name: 'Show', exact: true }).selectOption('empty');
  await expect(view.getByRole('table').locator('tbody tr')).toHaveCount(1);
  await expect(view.getByRole('table').getByRole('button', { name: 'audit', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 540, height: 820 });
  await view.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('accounts-narrow.png'), fullPage: true });
  expect(await page.evaluate(() => sessionStorage.getItem('unexpected-account-command'))).toBeNull();
});
