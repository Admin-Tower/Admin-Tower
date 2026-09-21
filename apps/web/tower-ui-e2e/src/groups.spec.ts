import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const hosts = ['Alpha', 'Beta'].map((name, index) => ({ id: `host-${index}`, settings: {
      name, address: `192.0.2.${index + 1}`, username: 'fixture', port: 2222,
      authentication: { kind: 'keyFile', filename: 'test key' },
    } }));
    type Group = { id: string; name: string; memberIds: string[] };
    type Run = { id: string; targetLabel: string; active: boolean; elapsedMs: number; message: string;
      results: { host: typeof hosts[number]; outcome: string; diagnostics: string }[] };
    let groups: Group[] = [{ id: 'servers', name: 'Servers', memberIds: ['host-0', 'host-1'] }, { id: 'web', name: 'Web', memberIds: ['host-0'] }];
    let run: Run | null = null;
    let polls = 0;
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { id?: string; name?: string; memberIds?: string[]; targets?: { hostIds: string[]; groupIds: string[] }; runId?: string } = {}) => {
        switch (command) {
          case 'list_hosts': return hosts;
          case 'list_identities': return { agentIdentities: [], keyFiles: ['test key'], agentError: null, keyError: null };
          case 'list_terminals': return [];
          case 'host_system_info':
          case 'inspect_host': return { sections: [] };
          case 'list_host_groups': return groups;
          case 'save_host_group': {
            if (!args.name || !args.memberIds) throw new Error('Missing group data');
            const group = { id: args.id ?? crypto.randomUUID(), name: args.name, memberIds: args.memberIds };
            groups = [...groups.filter(g => g.id !== group.id), group]; return group;
          }
          case 'delete_host_group': groups = groups.filter(g => g.id !== args.id); return;
          case 'ansible_availability':
            if (localStorage.getItem('no-ansible')) throw new Error('Cannot run /usr/bin/ansible. Install ansible-core outside Admin-Tower.');
            return 'ansible [core 2.20.1]';
          case 'start_ping': {
            if (run?.active) throw new Error('A ping is already running.');
            localStorage.setItem('start-count', String(Number(localStorage.getItem('start-count') ?? '0') + 1));
            if (Object.keys(args).join(',') !== 'targets' || !args.targets) throw new Error('Only saved target IDs are accepted');
            const selectedGroups = args.targets.groupIds.map(id => {
              const group = groups.find(g => g.id === id);
              if (!group) throw new Error('Unknown group');
              return group;
            });
            const selectedHosts = args.targets.hostIds.map(id => {
              const host = hosts.find(h => h.id === id);
              if (!host) throw new Error('Unknown host');
              return host;
            });
            const targetIds = new Set([...args.targets.hostIds, ...selectedGroups.flatMap(group => group.memberIds)]);
            polls = 0;
            run = { id: crypto.randomUUID(), targetLabel: [...selectedGroups.map(g => g.name), ...selectedHosts.map(h => h.settings.name)].join(', '), active: true, elapsedMs: 0, message: '',
              results: hosts.filter(h => targetIds.has(h.id)).map(host => ({ host, outcome: 'waiting', diagnostics: '' })) };
            return structuredClone(run);
          }
          case 'latest_ping':
            if (run?.active) {
              run.elapsedMs = ++polls * 1000;
              if (polls >= 2) { run.results[0].outcome = 'successful'; run.results[0].diagnostics = '{"ping":"pong"}'; }
              if (polls >= 4 && !localStorage.getItem('slow-ping')) {
                run.active = false;
                if (run.results[1]) { run.results[1].outcome = 'unreachable'; run.results[1].diagnostics = 'Host key verification failed'; }
              }
            }
            return structuredClone(run);
          case 'cancel_ping':
            if (run && run.id === args.runId) {
              run.active = false;
              run.results.filter(r => r.outcome === 'waiting').forEach(r => { r.outcome = 'cancelled'; });
            }
            return;
          default: throw new Error(`Unexpected native command ${command}`);
        }
      },
    } });
  });
  await page.goto('/hosts');
});

async function navigate(page: import('@playwright/test').Page, name: string) {
  const nav = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name, exact: true });
  if (!await nav.isVisible()) await page.getByRole('button', { name: 'Toggle sidenav' }).click();
  await nav.click();
}

test('keeps hosts and groups separate and runs their session selection with one card click', async ({ page }, testInfo) => {
  await expect(page.locator('mat-nav-list a')).toHaveText(['Hosts', 'Groups', 'Automation']);
  await expect(page.getByRole('list', { name: 'Saved groups' })).toHaveCount(0);
  await page.getByRole('checkbox', { name: /Select Alpha/ }).check();
  await navigate(page, 'Groups');
  await expect(page.getByRole('list', { name: 'Saved hosts' })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Select group Servers' }).check();
  await page.getByRole('checkbox', { name: 'Select group Web' }).check();
  await expect(page.getByLabel('Session selection')).toContainText('1 host + 2 groups selected · 2 unique hosts');
  await page.screenshot({ path: testInfo.outputPath('groups-selection.png'), fullPage: true });
  await navigate(page, 'Hosts');
  await expect(page.getByRole('checkbox', { name: /Select Alpha/ })).toBeChecked();
  await expect(page.getByText('Included via selected group')).toHaveCount(2);
  await navigate(page, 'Automation');
  await expect(page.getByLabel('Inventory selection')).toContainText('1 host + 2 groups selected');
  await expect(page.getByLabel('Inventory selection')).toContainText('2 unique hosts');
  await page.screenshot({ path: testInfo.outputPath('automation-run-card.png'), fullPage: true });
  await page.getByRole('button', { name: 'Run Ping', exact: true }).click();
  await expect(page).toHaveURL(/\/automation\/ping$/);
  const panel = page.getByRole('region', { name: 'Latest run' });
  await expect(panel.getByRole('status')).toContainText('2 / 2 complete');
  await expect(panel.getByRole('list', { name: 'Ping host results' }).getByRole('listitem')).toHaveCount(2);
  expect(await page.evaluate(() => localStorage.getItem('start-count'))).toBe('1');
  await navigate(page, 'Hosts');
  await expect(page.getByRole('checkbox', { name: /Select Alpha/ })).not.toBeChecked();
  await navigate(page, 'Groups');
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await navigate(page, 'Automation');
  await expect(page.getByRole('button', { name: 'Run Ping', exact: true })).toBeDisabled();
  await page.getByRole('link', { name: 'View Ping results and details' }).click();
  await expect(panel.getByRole('status')).toContainText('2 / 2 complete');
  expect(await page.evaluate(() => localStorage.getItem('start-count'))).toBe('1');
});

test('deselecting a group preserves independently selected hosts and other groups', async ({ page }) => {
  await page.getByRole('checkbox', { name: /Select Alpha/ }).check();
  await navigate(page, 'Groups');
  await page.getByRole('checkbox', { name: 'Select group Servers' }).check();
  await page.getByRole('checkbox', { name: 'Select group Web' }).check();
  await page.getByRole('checkbox', { name: 'Select group Servers' }).uncheck();
  await expect(page.getByLabel('Session selection')).toContainText('1 host + 1 group selected · 1 unique host');
  await navigate(page, 'Hosts');
  await expect(page.getByRole('checkbox', { name: /Select Alpha/ })).toBeChecked();
  await navigate(page, 'Automation');
  await page.getByRole('button', { name: 'Run Ping', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Latest run' }).getByRole('status')).toContainText('1 / 1 complete');
});

test('quick Run Ping uses all selected rows including hidden hosts and works on mobile', async ({ page }, testInfo) => {
  await page.getByRole('checkbox', { name: 'Select visible hosts' }).check();
  await page.getByRole('searchbox', { name: 'Search hosts' }).fill('Beta');
  await expect(page.getByText('2 hosts selected · 1 hidden by filters', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('mat-sidenav')).not.toBeVisible();
  await page.getByRole('button', { name: '▶ Run Ping', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('hosts-run-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '▶ Run Ping', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Latest run' }).getByRole('status')).toContainText('2 / 2 complete');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('failed starts retain the selection and an active run cannot consume the next selection', async ({ page }) => {
  await page.getByRole('checkbox', { name: /Select Alpha/ }).check();
  await page.evaluate(() => localStorage.setItem('no-ansible', '1'));
  await navigate(page, 'Automation');
  await page.getByRole('button', { name: 'Run Ping', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Cannot run /usr/bin/ansible');
  await expect(page.getByLabel('Inventory selection')).toContainText('1 host selected');
  await page.evaluate(() => { localStorage.removeItem('no-ansible'); localStorage.setItem('slow-ping', '1'); });
  await page.getByRole('button', { name: 'Run Ping', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Latest run' });
  await expect(panel.getByText('Running', { exact: true })).toBeVisible();
  await navigate(page, 'Groups');
  await page.getByRole('checkbox', { name: 'Select group Servers' }).check();
  await navigate(page, 'Automation');
  await page.getByRole('button', { name: 'Run Ping', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('already running');
  await expect(page.getByLabel('Inventory selection')).toContainText('1 group selected');
  await page.getByRole('link', { name: 'View Ping results and details' }).click();
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click();
  await expect(panel.getByText('Finished', { exact: true })).toBeVisible();
  await navigate(page, 'Groups');
  await expect(page.getByRole('checkbox', { name: 'Select group Servers' })).toBeChecked();
});

test('group membership editing uses host rows without replacing session targets', async ({ page }) => {
  await page.getByRole('checkbox', { name: /Select Beta/ }).check();
  await navigate(page, 'Groups');
  await page.getByRole('checkbox', { name: 'Select group Servers' }).check();
  await page.getByRole('link', { name: 'Edit group Web', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Group editor' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Select Alpha/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Select Beta/ })).not.toBeChecked();
  await page.getByRole('checkbox', { name: /Select Beta/ }).check();
  await page.getByRole('textbox', { name: 'Group name' }).fill('Web fleet');
  await page.getByRole('button', { name: 'Save group', exact: true }).click();
  await expect(page).toHaveURL(/\/groups$/);
  await expect(page.getByLabel('Session selection')).toContainText('1 host + 1 group selected');
  await expect(page.getByRole('checkbox', { name: 'Select group Servers' })).toBeChecked();
  const card = page.getByRole('listitem').filter({ has: page.getByRole('checkbox', { name: 'Select group Web fleet' }) });
  await expect(card).toContainText('2 hosts');
  await page.getByRole('button', { name: 'Delete group Web fleet' }).click();
  await page.getByRole('button', { name: 'Confirm delete group' }).click();
  await expect(page.getByRole('checkbox', { name: 'Select group Web fleet' })).toHaveCount(0);
  await navigate(page, 'Hosts');
  await expect(page.getByRole('checkbox', { name: /Select Alpha/ })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Select Beta/ })).toBeChecked();
  await expect(page.getByRole('list', { name: 'Saved hosts' }).getByRole('listitem')).toHaveCount(2);
});

test('creates groups from selected rows and explores shared memberships without changing selection', async ({ page }) => {
  await page.getByRole('checkbox', { name: /Select Alpha/ }).check();
  await page.getByRole('button', { name: 'Save as group' }).click();
  await page.getByRole('textbox', { name: 'Group name' }).fill('New fleet');
  await page.getByRole('button', { name: 'Save group', exact: true }).click();
  await expect(page).toHaveURL(/\/groups$/);
  await expect(page.getByRole('checkbox', { name: 'Select group New fleet' })).toBeVisible();
  const card = page.getByRole('listitem').filter({ has: page.getByRole('checkbox', { name: 'Select group Servers' }) });
  await card.getByRole('link', { name: 'Web · 1', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Saved hosts' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('checkbox', { name: /Select Alpha/ })).toBeChecked();
  await page.getByRole('button', { name: 'Show all hosts', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Saved hosts' }).getByRole('listitem')).toHaveCount(2);
});


test('shows live Ping outcomes and diagnostics in host rows across navigation', async ({ page }, testInfo) => {
  await expect(page.getByLabel('Ping for Alpha: Not checked', { exact: true })).toBeVisible();
  await page.evaluate(() => localStorage.setItem('slow-ping', '1'));
  await page.getByRole('checkbox', { name: 'Select visible hosts' }).check();
  await navigate(page, 'Automation');
  await page.getByRole('button', { name: 'Run Ping', exact: true }).click();
  await expect(page).toHaveURL(/\/automation\/ping$/);
  await navigate(page, 'Hosts');
  await expect(page.getByLabel('Ping for Beta: Waiting', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Ping for Alpha: Passed', { exact: true })).toBeVisible();
  await page.evaluate(() => localStorage.removeItem('slow-ping'));
  await expect(page.getByLabel('Ping for Beta: Unreachable', { exact: true })).toBeVisible();
  await page.getByLabel('Ping for Beta: Unreachable', { exact: true }).click();
  await expect(page.getByText('Host key verification failed', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('hosts-ping-status.png'), fullPage: true });
  await navigate(page, 'Groups');
  await navigate(page, 'Hosts');
  await expect(page.getByLabel('Ping for Alpha: Passed', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Ping for Beta: Unreachable', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('mat-sidenav')).not.toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('hosts-ping-status-mobile.png'), fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
