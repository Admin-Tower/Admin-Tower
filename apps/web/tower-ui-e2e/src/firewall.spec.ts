import { expect, test } from '@playwright/test';
import { nftFixture } from '../../tower-ui/src/app/host-detail/firewall/firewall.fixture';

test('explores firewall chains, rules and zones without changing the host', async ({ page }, testInfo) => {
  const sections = [
    { id: 'nftables', status: 'ok', truncated: false, output: nftFixture },
    { id: 'iptables', status: 'ok', truncated: false, output: '*filter\n:INPUT DROP [0:0]\n:OUTPUT ACCEPT [0:0]\n:trusted - [0:0]\n[3:120] -A INPUT -i eth0 -p tcp --dport 22 -m comment --comment "SSH office" -j ACCEPT\n-A INPUT -j DROP\n-A INPUT -j trusted\n-A trusted -j RETURN\nCOMMIT' },
    { id: 'ip6tables', status: 'denied', truncated: false, output: 'Permission denied' },
    { id: 'ufw', status: 'unavailable', truncated: false, output: 'Tool not installed' },
    { id: 'firewalld', status: 'ok', truncated: false, output: 'public (active)\n  target: default\n  interfaces: eth0\n  services: ssh https\n  ports: 8443/tcp\n  rich rules:\n    rule family="ipv4" source address="192.0.2.0/24" reject' },
  ];
  await page.addInitScript((sections) => {
    const host = { id: 'firewall-host', settings: { name: 'Edge gateway', username: 'admin', address: 'gateway.example.com', port: 22, authentication: { kind: 'keyFile', filename: 'id_ed25519' } } };
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { invoke: async (command: string) => {
      if (command === 'list_hosts') return [host];
      if (command === 'list_terminals') return [{ id: 'xterm', label: 'xterm' }];
      if (command === 'inspect_host') return { supported: true, elevated: false, collectedAt: 1789800000, sections };
      sessionStorage.setItem('unexpected-firewall-command', command);
      throw new Error('Unexpected native command');
    } } });
  }, sections);
  await page.goto('/hosts/firewall-host');
  await page.getByRole('button', { name: 'Firewall', exact: true }).click();
  const view = page.getByRole('region', { name: 'Firewall inspection', exact: true });
  const sources = page.getByRole('navigation', { name: 'Firewall sources' });
  await expect(sources.getByRole('button', { name: /nftables/ })).toHaveAttribute('aria-pressed', 'true');
  const table = view.getByRole('table', { name: 'nftables rules' });
  await expect(table.locator('tbody > tr')).toHaveCount(3);
  await expect(view.getByText('Policy: drop', { exact: false })).toBeVisible();
  await view.getByRole('combobox', { name: 'Chain / zone', exact: true }).selectOption({ label: 'inet filter / input' });
  await expect(table.locator('tbody > tr')).toHaveCount(2);
  await view.getByRole('combobox', { name: 'Action', exact: true }).selectOption('ACCEPT');
  await view.getByRole('searchbox', { name: 'Search rules', exact: true }).fill('192.0.2.0');
  await expect(table.locator('tbody > tr')).toHaveCount(1);
  await table.getByRole('button', { name: 'Details for input rule 1' }).click();
  await expect(view.getByText('12 packets · 2048 bytes')).toBeVisible();
  await expect(view.locator('p').filter({ hasText: 'Comment: Allow SSH from trusted network' })).toBeVisible();
  await expect(table.locator('details')).not.toHaveAttribute('open');
  await page.screenshot({ path: testInfo.outputPath('firewall-rule-detail.png'), fullPage: true });
  await view.getByRole('button', { name: 'Clear firewall filters' }).click();
  await table.getByRole('button', { name: 'Sort firewall by Action', exact: true }).click();
  await expect(view.getByRole('button', { name: 'Restore rule order' })).toBeVisible();
  await view.getByRole('button', { name: 'Restore rule order' }).click();
  await expect(table.locator('tbody > tr').first().getByText('ACCEPT', { exact: true })).toBeVisible();
  await view.getByRole('searchbox', { name: 'Search rules', exact: true }).fill('no-matching-rule');
  await expect(view.getByText('No firewall rules match these filters.')).toBeVisible();
  await sources.getByRole('button', { name: /iptables · IPv4/ }).click();
  await expect(view.getByRole('searchbox', { name: 'Search rules', exact: true })).toHaveValue('');
  await expect(view.getByRole('table', { name: 'iptables · IPv4 rules' }).getByText('22', { exact: true })).toBeVisible();
  const iptables = view.getByRole('table', { name: 'iptables · IPv4 rules' });
  await expect(iptables.locator('.chain-heading')).toHaveCount(3);
  await expect(iptables.locator('.chain-heading').first()).toContainText('Policy: DROP');
  await expect(iptables.locator('tbody').nth(1)).toContainText('No rules captured in this chain.');
  await view.getByRole('checkbox', { name: 'Interfaces', exact: true }).check();
  await view.getByRole('checkbox', { name: 'Traffic counters', exact: true }).check();
  await expect(iptables.getByText('eth0', { exact: true })).toBeVisible();
  await expect(iptables.getByText('120', { exact: true })).toBeVisible();
  await iptables.getByRole('button', { name: 'Follow JUMP → trusted', exact: true }).click();
  await expect(iptables.locator('.chain-heading')).toHaveCount(1);
  await expect(iptables.locator('.chain-heading')).toContainText('trusted');
  await view.getByRole('button', { name: 'Back to previous chain view' }).click();
  await expect(iptables.locator('.chain-heading')).toHaveCount(3);
  await iptables.getByRole('button', { name: '▾ INPUT', exact: true }).click();
  await expect(iptables.getByRole('button', { name: 'Follow JUMP → trusted', exact: true })).toHaveCount(0);
  await view.getByRole('button', { name: 'Expand chains', exact: true }).click();
  await iptables.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('iptables-chains.png'), fullPage: true });
  await sources.getByRole('button', { name: /iptables · IPv6/ }).click();
  await expect(view.getByRole('button', { name: 'Review privileged inspection' })).toBeVisible();
  await expect(view.getByRole('table')).toHaveCount(0);
  await sources.getByRole('button', { name: /firewalld/ }).click();
  await expect(view.getByText('public (active)', { exact: true }).first()).toBeVisible();
  await expect(view.getByRole('table').getByText('Rich rule', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 540, height: 820 });
  await expect(page.getByRole('button', { name: 'Toggle sidenav' })).toHaveAttribute('aria-expanded', 'false');
  await view.getByRole('heading', { name: 'firewalld', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('firewall-zones-narrow.png'), fullPage: true });
  expect(await page.evaluate(() => sessionStorage.getItem('unexpected-firewall-command'))).toBeNull();
});
