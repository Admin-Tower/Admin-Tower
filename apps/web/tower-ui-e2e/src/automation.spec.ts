import { expect, test } from '@playwright/test';

test('the browser can explore the catalog and clearly sees the desktop requirement', async ({ page }) => {
  await page.goto('/automation');
  await expect(page.getByRole('heading', { name: 'Automation', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'View Ping results and details', exact: true }).click();
  await expect(page).toHaveURL(/\/automation\/ping$/);
  await expect(page.getByRole('heading', { name: 'Open Admin-Tower for Linux' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run ping', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Ping', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Automation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Task catalog' })).toBeVisible();
});


test('Ubuntu updates open for review without executing from the catalog', async ({ page }) => {
  await page.goto('/automation');
  await page.getByRole('button', { name: 'Open Ubuntu package updates', exact: true }).click();
  await expect(page).toHaveURL(/\/automation\/packages$/);
  await expect(page.getByRole('heading', { name: 'Ubuntu package updates', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Open Admin-Tower for Linux' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview updates', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Ubuntu package updates', exact: true })).toBeVisible();
});


test('desktop package workflow requires review and preserves results across navigation', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.addInitScript(() => {
    const host = { id: 'ubuntu-1', settings: { name: 'Ubuntu Server', address: '192.0.2.20', username: 'admin', port: 22,
      authentication: { kind: 'keyFile', filename: 'fixture' } } };
    let polls = 0;
    const read = () => JSON.parse(localStorage.getItem('package-run') ?? 'null');
    const save = (value: unknown) => { localStorage.setItem('package-run', JSON.stringify(value)); return value; };
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { runId?: string; targets?: { hostIds: string[]; groupIds: string[] } } = {}) => {
        switch (command) {
          case 'list_hosts': return [host];
          case 'list_identities': return { agentIdentities: [], keyFiles: ['fixture'], agentError: null, keyError: null };
          case 'list_terminals': return [];
          case 'list_host_groups': return [];
          case 'latest_ping': return null;
          case 'latest_reboots': return null;
          case 'preview_packages':
            if (args.targets?.hostIds.join() !== host.id) throw new Error('Unexpected target');
            return save({ id: 'reviewed-run', targetLabel: 'Ubuntu Server', phase: 'review', active: false, stopRequested: false,
              results: [{ host, state: 'ready', message: 'Preview ready', rebootRequired: false, logs: '$ apt-get update\nFetched indexes',
                plan: { os: 'Ubuntu 24.04 LTS', createdAt: Math.floor(Date.now() / 1000), failedServices: [], deferred: ['linux-image-generic'],
                  packages: [{ name: 'curl:amd64', fromVersion: '8.5.0-1', toVersion: '8.5.0-2' }] } }] });
          case 'apply_packages': {
            if (args.runId !== 'reviewed-run') throw new Error('Only reviewed run can be applied');
            localStorage.setItem('package-applies', '1');
            const run = read(); run.phase = 'apply'; run.active = true; run.results[0].state = 'running'; run.results[0].logs += '\nAPT: installing approved versions'; return save(run);
          }
          case 'latest_packages': {
            const run = read();
            if (run?.active && ++polls >= 3) {
              run.active = false; run.phase = 'finished'; run.results[0].state = 'successful'; run.results[0].rebootRequired = true;
              run.results[0].message = 'Approved versions installed'; run.results[0].logs += '\nSetting up curl'; save(run);
            }
            return run;
          }
          default: throw new Error('Unexpected command: ' + command);
        }
      },
    } });
  });
  await page.goto('/hosts');
  await page.getByRole('checkbox', { name: /Select Ubuntu Server/ }).check();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Automation', exact: true }).click();
  await page.getByRole('button', { name: 'Open Ubuntu package updates', exact: true }).click();
  await page.getByRole('button', { name: 'Preview updates', exact: true }).click();
  await expect(page.getByRole('cell', { name: '8.5.0-2', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('package-applies'))).toBeNull();
  await expect(page.getByRole('log')).toContainText('$ apt-get update');
  await page.screenshot({ path: testInfo.outputPath('ubuntu-package-review.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('mat-sidenav')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply reviewed updates to 1 host', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Apply reviewed updates to 1 host', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('ubuntu-package-review-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Apply reviewed updates to 1 host', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('APT: installing approved versions');
  await expect(page.getByText('Updating', { exact: true })).toBeVisible();
  await expect(page.getByRole('log')).not.toContainText('Setting up curl');
  await expect(page.getByText('Reboot required · no automatic reboot', { exact: true })).toBeVisible();
  await expect(page.getByRole('log')).toContainText('Setting up curl');
  await expect(page.getByText('Successful', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Successful', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('package-applies'))).toBe('1');
  await page.getByRole('button', { name: 'Review reboot', exact: true }).click();
  await expect(page).toHaveURL(/\/automation\/reboot$/);
  await expect(page.getByRole('heading', { name: 'Reboot Ubuntu hosts', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review reboot', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Reboot 1 host now', exact: true })).toHaveCount(0);
});

for (const deferred of [true, false]) {
  test(`empty preview explains ${deferred ? 'deferred updates' : 'no available updates'}`, async ({ page }, testInfo) => {
    await page.addInitScript((hasDeferred) => {
      const host = { id: 'ubuntu-empty', settings: { name: 'Ubuntu Server', address: '192.0.2.20', username: 'root', port: 22,
        authentication: { kind: 'keyFile', filename: 'fixture' } } };
      const run = { id: 'empty-preview', targetLabel: 'Ubuntu Server', phase: 'review', active: false, stopRequested: false,
        results: [{ host, state: 'ready', message: 'Preview ready. Package indexes refreshed; no packages installed.', rebootRequired: false,
          logs: '$ /usr/bin/apt-get update\nReading package lists...',
          plan: { os: 'Ubuntu 26.04.1 LTS', createdAt: Math.floor(Date.now() / 1000), packages: [], failedServices: [],
            deferred: hasDeferred ? ['linux-firmware-amd-graphics:amd64', 'software-properties-common:amd64'] : [] } }] };
      Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          switch (command) {
            case 'list_hosts': return [host];
            case 'list_host_groups': return [];
            case 'latest_ping': return null;
            case 'latest_packages': return run;
            default: throw new Error('Unexpected command: ' + command);
          }
        },
      } });
    }, deferred);
    await page.goto('/automation/packages');
    await expect(page.getByRole('heading', { name: deferred ? 'No updates can be applied by this task' : 'No package updates available' })).toBeVisible();
    await expect(page.getByText('Preview complete · nothing to apply', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Apply reviewed updates/ })).toHaveCount(0);
    await expect(page.getByText('Ready for review', { exact: true })).toHaveCount(0);
    if (deferred) {
      await expect(page.getByText('Updates deferred', { exact: true })).toBeVisible();
      await expect(page.getByText('Up to date', { exact: true })).toHaveCount(0);
    } else {
      await expect(page.getByText('Up to date', { exact: true })).toBeVisible();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('mat-sidenav')).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('empty-preview-mobile.png'), fullPage: true, animations: 'disabled' });
  });
}

test('reboot requires confirmation, shows live output, and recovers without resubmitting', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const host = { id: 'ubuntu-reboot', settings: { name: 'Ubuntu Server', address: '192.0.2.20', username: 'root', port: 22,
      authentication: { kind: 'keyFile', filename: 'fixture' } } };
    const read = () => JSON.parse(localStorage.getItem('reboot-run') ?? 'null');
    const save = (value: unknown) => { localStorage.setItem('reboot-run', JSON.stringify(value)); return value; };
    let polls = 0;
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { runId?: string; targets?: { hostIds: string[] } } = {}) => {
        switch (command) {
          case 'list_hosts': return [host];
          case 'list_identities': return { agentIdentities: [], keyFiles: ['fixture'], agentError: null, keyError: null };
          case 'list_terminals': return [];
          case 'list_host_groups': return [];
          case 'latest_ping': return null;
          case 'preview_reboots':
            if (args.targets?.hostIds.join() !== host.id) throw new Error('Wrong reboot target');
            return save({ id: 'reviewed-reboot', targetLabel: 'Ubuntu Server', phase: 'review', active: false, stopRequested: false,
              results: [{ host, state: 'ready', message: 'Review complete. No reboot has been requested.', logs: 'Preflight complete', rebootRequired: true,
                plan: { os: 'Ubuntu 26.04 LTS', createdAt: Math.floor(Date.now() / 1000), bootId: 'old-boot', requestedBy: ['libc6'], failedServices: [] } }] });
          case 'apply_reboots': {
            if (args.runId !== 'reviewed-reboot') throw new Error('Wrong reboot review');
            if (localStorage.getItem('reboot-submitted')) throw new Error('Duplicate reboot submission');
            localStorage.setItem('reboot-submitted', '1');
            const run = read(); run.phase = 'apply'; run.active = true; run.results[0].state = 'launching';
            run.results[0].logs = '$ shutdown -r now\nWaiting for a new boot ID…'; return save(run);
          }
          case 'latest_reboots': {
            const run = read();
            if (run?.active && ++polls >= 3) {
              run.active = false; run.phase = 'finished'; run.results[0].state = 'unknown'; run.results[0].message = 'Connection lost'; save(run);
            }
            return run;
          }
          case 'refresh_reboots': {
            const run = read(); run.results[0].state = 'successful'; run.results[0].rebootRequired = false;
            run.results[0].message = 'New boot verified; SSH and systemd are ready.'; return save(run);
          }
          default: throw new Error('Unexpected command: ' + command);
        }
      },
    } });
  });
  await page.goto('/hosts');
  await page.getByRole('checkbox', { name: /Select Ubuntu Server/ }).check();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Automation', exact: true }).click();
  await page.getByRole('button', { name: 'Open Reboot Ubuntu hosts', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('reboot-run'))).toBeNull();
  await page.getByRole('button', { name: 'Review reboot', exact: true }).click();
  await expect(page.getByText('Requested by: libc6', { exact: true })).toBeVisible();
  const reboot = page.getByRole('button', { name: 'Reboot 1 host now', exact: true });
  await expect(reboot).toBeDisabled();
  await page.reload();
  await expect(reboot).toBeDisabled();
  expect(await page.evaluate(() => localStorage.getItem('reboot-submitted'))).toBeNull();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('mat-sidenav')).not.toBeVisible();
  await page.getByRole('checkbox', { name: 'I understand these hosts will temporarily go offline.' }).check();
  await expect(reboot).toBeEnabled();
  await reboot.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('reboot-review-mobile.png'), fullPage: true, animations: 'disabled' });
  await reboot.click();
  await expect(page.getByRole('log')).toContainText('Waiting for a new boot ID');
  await expect(page.getByText('Outcome unconfirmed', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Refresh reboot status', exact: true }).click();
  await expect(page.getByText('Reboot verified', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('reboot-submitted'))).toBe('1');
});
