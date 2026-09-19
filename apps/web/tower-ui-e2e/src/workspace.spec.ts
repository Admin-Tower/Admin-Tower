import { expect, test } from '@playwright/test';

test('keeps context, reviews row actions in place and switches hosts directly', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const hosts = ['Alpha', 'Beta'].map(name => ({ id: name.toLowerCase(), settings: { name, address: name.toLowerCase() + '.example.com', username: 'admin', port: 22, authentication: { kind: 'agent', fingerprint: 'SHA256:fixture' } } }));
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown> = {}) => {
      if (command === 'list_hosts') return hosts;
      if (command === 'list_terminals') return [{ id: 'xterm', label: 'xterm' }];
      if (command === 'inspect_host') return { collectedAt: Date.now() / 1000, supported: true, elevated: false, sections: [
        { id: 'system', status: 'ok', truncated: false, output: 'PRETTY_NAME="Debian GNU/Linux"' },
        { id: 'services', status: 'ok', truncated: false, output: 'ssh.service loaded active running OpenSSH\ncron.service loaded active running Scheduled tasks\nworker.service loaded failed failed Worker' },
      ] };
      if (command === 'review_host_action') {
        const action = args['action'] as { verb: string; unit: string };
        return { id: 'review', host: hosts.find(h => h.id === args['id']), summary: action.verb + ' ' + action.unit, command: 'systemctl ' + action.verb + ' -- ' + action.unit, warning: 'The service will restart.', expiresAt: Date.now() / 1000 + 300 };
      }
      if (command === 'start_host_action') { sessionStorage.setItem('executed', 'yes'); throw new Error('This test must not execute actions'); }
      throw new Error('Unexpected command ' + command);
    } } });
  });
  await page.goto('/hosts/alpha?tab=services');
  const search = page.getByRole('searchbox', { name: 'Search Loaded services', exact: true });
  await search.fill('ssh');
  const restart = page.getByRole('button', { name: 'Restart ssh.service', exact: true });
  await restart.click();
  const dialog = page.getByRole('dialog', { name: 'Review: restart ssh.service' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#review-heading')).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('service-review.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(restart).toBeFocused();
  expect(await page.evaluate(() => sessionStorage.getItem('executed'))).toBeNull();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.goBack();
  await expect(search).toHaveValue('ssh');
  await expect(page.getByRole('table', { name: 'Loaded services', exact: true }).locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Services', exact: true }).focus();
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  await page.getByRole('combobox', { name: 'Switch host', exact: true }).selectOption('beta');
  await expect(page.getByRole('heading', { name: 'Beta', exact: true })).toBeVisible();
  await expect(search).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Services', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.screenshot({ path: testInfo.outputPath('services-workspace.png') });
  await page.setViewportSize({ width: 540, height: 820 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('services-workspace-narrow.png') });
  expect(errors).toEqual([]);
});
