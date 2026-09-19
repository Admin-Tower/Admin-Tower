import { firewallData } from './firewall-data';
import { HostSection } from '../../hosts/hosts.service';
const section = (id: string, output: string): HostSection => ({ id, output, status: 'ok', truncated: false });
import { nftFixture } from './firewall.fixture';

describe('firewall models', () => {
  it('models nft rules, policies, hooks, counters and objects without merging families', () => {
    const data = firewallData(section('nftables', nftFixture));
    expect(data.scopes).toHaveLength(2); expect(data.rules).toHaveLength(3);
    expect(data.scopes[0].policy).toBe('drop'); expect(data.scopes[0].priority).toBe('0');
    expect(data.rules[0]).toMatchObject({ order: 1, protocol: 'tcp', source: '!= 192.0.2.0/24', ports: 'Destination 22', action: 'ACCEPT', counters: '12 packets · 2048 bytes' });
    expect(data.rules[1]).toMatchObject({ order: 2, action: 'JUMP → trusted' });
    expect(data.rules[1].conditions[0]).toContain('established, related');
    expect(data.rules[2].order).toBe(1);
    expect(data.objects.map(o => o.type)).toEqual(['table', 'set']);
  });
  it('keeps unfamiliar expressions exact and never interprets missing data as an empty firewall', () => {
    const data = firewallData(section('nftables', JSON.stringify({ nftables: [{ rule: { family: 'inet', table: 'f', chain: 'i', expr: [{ vmap: { key: 'custom', data: 'map' } }] } }] })));
    expect(data.rules[0].action).toBe('No explicit verdict'); expect(data.rules[0].conditions[0]).toContain('vmap');
    expect(firewallData(section('nftables', 'table inet filter {')).problem).toContain('Structured');
    expect(firewallData(section('nftables', '{}')).problem).toContain('unrecognized');
    expect(firewallData(section('nftables', '{"nftables":[]}')).problem).toBe('');
    expect(firewallData({ ...section('nftables', nftFixture), status: 'denied' }).rules).toHaveLength(0);
  });
  it('parses iptables order, policies, inversion and quoted comments without changing rule semantics', () => {
    const data = firewallData(section('iptables', '*filter\n:INPUT DROP [0:0]\n:trusted - [0:0]\n[3:120] -A INPUT ! -s 192.0.2.0/24 -i eth0 ! -o br0 -p tcp --sport 1024:65535 --dport 22 -m comment --comment "SSH from office" -j ACCEPT\n-A INPUT -j trusted\n-A trusted -j RETURN\nCOMMIT'));
    expect(data.scopes[0].policy).toBe('DROP'); expect(data.scopes[1].policy).toBe('');
    expect(data.rules[0]).toMatchObject({ source: '!= 192.0.2.0/24', ports: 'Source 1024:65535; Destination 22', sourcePorts: '1024:65535', destinationPorts: '22', inputInterface: 'eth0', outputInterface: '!= br0', packets: '3', bytes: '120', comment: 'SSH from office', counters: '3 packets · 120 bytes', action: 'ACCEPT' });
    expect(data.rules[1].action).toBe('JUMP → trusted'); expect(data.rules[2].order).toBe(1);
    expect(data.diagnostics).toEqual([]);
  });
  it('does not lose malformed iptables lines or guess a missing table', () => {
    const data = firewallData(section('ip6tables', '-A INPUT -j ACCEPT\n*filter\n-A INPUT --comment "unterminated\nCOMMIT'));
    expect(data.rules).toEqual([]); expect(data.diagnostics).toHaveLength(2);
  });
  it('separates UFW status, default policy, direction and IPv6 rules', () => {
    const data = firewallData(section('ufw', 'Status: active\nDefault: deny (incoming), allow (outgoing)\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW IN    10.0.0.0/8\n443/tcp (v6)               DENY OUT    Anywhere (v6)'));
    expect(data.properties).toContainEqual(['Status', 'active']);
    expect(data.rules[0]).toMatchObject({ chain: 'Incoming', action: 'ALLOW', protocol: 'tcp' });
    expect(data.rules[1]).toMatchObject({ chain: 'Outgoing', family: 'IPv6', action: 'DENY' });
    expect(data.diagnostics).toEqual([]);
  });
  it('shows firewalld zone targets and preserves rich rules as complete entries', () => {
    const data = firewallData(section('firewalld', 'public (active)\n  target: default\n  interfaces: eth0\n  services: ssh https\n  ports: 8443/tcp\n  rich rules:\n    rule family="ipv4" source address="192.0.2.0/24" reject\ntrusted\n  target: ACCEPT\n  sources: 10.0.0.0/8'));
    expect(data.scopes).toHaveLength(2); expect(data.rules).toHaveLength(4);
    expect(data.scopes[0].attributes).toContainEqual(['interfaces', 'eth0']);
    expect(data.scopes[1].policy).toBe('ACCEPT');
    expect(data.rules[3].action).toBe('Rich rule'); expect(data.rules[3].raw).toContain('reject');
  });
  it('keeps quoted option-like comments separate and distinguishes extension targets from chains', () => {
    const data = firewallData(section('iptables', '*filter\n:INPUT DROP [0:0]\n-A INPUT -p tcp --syn -m comment --comment "--dport" -j TCPMSS\nCOMMIT'));
    expect(data.rules[0]).toMatchObject({ comment: '--dport', destinationPorts: '', action: 'TCPMSS', target: 'TCPMSS' });
  });

});
