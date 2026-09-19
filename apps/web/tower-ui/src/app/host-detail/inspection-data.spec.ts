import { compareCells, inspectionData } from './inspection-data';
const parse = (id: string, output: string) => inspectionData({ id, output, status: 'ok', truncated: false });

describe('inspection tables', () => {
  it('keeps empty account fields aligned and reports malformed records', () => {
    const users = parse('users', 'admin:1000:1000::/home/admin:/bin/bash\ninvalid');
    expect(users.rows).toEqual([['admin', '1000', '1000', '', '/home/admin', '/bin/bash']]);
    expect(users.unparsed).toEqual(['invalid']);
    expect(parse('groups', 'ops:1001:admin,alice\nempty:1002:').rows).toEqual([['ops', '1001', 'admin, alice'], ['empty', '1002', '']]);
  });
  it('preserves process names with spaces and numeric fields', () => {
    const data = parse('processes', ' PID PPID USER %CPU %MEM STAT COMMAND\n 20 1 admin 10.2 2.4 Sl worker process\n 3 1 root 2.0 0.1 S init');
    expect(data.rows[0]).toEqual(['20', '1', 'admin', '10.2', '2.4', 'Sl', 'worker process']);
    expect(data.unparsed).toEqual([]);
    expect(data.sort).toEqual({ column: 3, descending: true });
  });
  it('sorts numbers, percentages, sizes and times by value', () => {
    expect(compareCells('2', '10', 'number')).toBeLessThan(0);
    expect(compareCells('90%', '100%', 'number')).toBeLessThan(0);
    expect(compareCells('900M', '1G', 'size')).toBeLessThan(0);
    expect(compareCells('512', '1K', 'size')).toBeLessThan(0);
    expect(compareCells('2GiB', '100MiB', 'size')).toBeGreaterThan(0);
    expect(compareCells('2026-09-19T12:00:00+0200', '2026-09-19T11:00:00+0000', 'time')).toBeLessThan(0);
  });
  it('preserves empty disk filesystem and mount fields in pair output', () => {
    const data = parse('disks', 'NAME="sda" TYPE="disk" SIZE="1T" FSTYPE="" MOUNTPOINT=""\nNAME="sda1" TYPE="part" SIZE="200G" FSTYPE="ext4" MOUNTPOINT="/media/my\\x20disk"');
    expect(data.rows).toEqual([['sda', 'disk', '1T', '', ''], ['sda1', 'part', '200G', 'ext4', '/media/my disk']]);
    expect(parse('disks', 'old unrecognized layout').unparsed).toHaveLength(1);
    expect(parse('storage', 'Filesystem Type Size Used Avail Use% Mounted on\n/dev/sda1 ext4 200G 40G 160G 20% /media/my disk').rows[0]).toEqual(['/dev/sda1', 'ext4', '200G', '40G', '160G', '20%', '/media/my disk']);
  });
  it('parses loaded, failed and static services without shifting descriptions', () => {
    expect(parse('services', 'ssh.service loaded active running OpenSSH server').rows[0]).toEqual(['ssh.service', 'loaded', 'active', 'running', 'OpenSSH server']);
    expect(parse('failedServices', '● broken.service loaded failed failed Failed worker').rows[0][2]).toBe('failed');
    expect(parse('serviceFiles', 'dbus.service static -').rows[0]).toEqual(['dbus.service', 'static', '-']);
  });
  it('parses network state, queues, addresses and route details', () => {
    expect(parse('interfaces', 'eth0 UP 10.0.0.1/24 fe80::1/64\neth1 DOWN').rows[1]).toEqual(['eth1', 'DOWN', '']);
    expect(parse('ports', 'Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\ntcp LISTEN 0 128 [::]:22 [::]:* users:(("sshd",pid=5,fd=3))').rows[0][6]).toContain('sshd');
    expect(parse('routes', 'default via 10.0.0.1 dev eth0 proto dhcp metric 100').rows[0]).toEqual(['default', '10.0.0.1', 'eth0', 'unicast', 'via 10.0.0.1 dev eth0 proto dhcp metric 100']);
    expect(parse('routes6', 'unreachable 2001:db8::/32 metric 10').rows[0][3]).toBe('unreachable');
  });
  it('preserves journal messages, continuations and unrecognized diagnostics', () => {
    const data = parse('logs', 'Hint: You are not seeing all messages\n2026-09-19T10:01:00+0200 host sshd[20]: Accepted publickey\n  continued message\n2026-09-19T10:02:00+0200 host kernel: device ready');
    expect(data.rows[0]).toEqual(['2026-09-19T10:01:00+0200', 'host', 'sshd[20]', 'Accepted publickey\ncontinued message']);
    expect(data.unparsed).toEqual(['Hint: You are not seeing all messages']);
  });
  it('retains firewall rule order, full expressions and policy context', () => {
    const data = parse('iptables', '*filter\n:INPUT DROP [0:0]\n\n-A INPUT -p tcp --dport 22 -j ACCEPT\nCOMMIT');
    expect(data.rows[1]).toEqual(['4', 'filter', 'INPUT', 'Rule', '-A INPUT -p tcp --dport 22 -j ACCEPT']);
    expect(data.rows[0][3]).toBe('Policy');
    expect(parse('nftables', 'table inet filter {\n\n chain input {\n }\n}').rows[1][0]).toBe('3');
    expect(parse('ufw', 'Status: active\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW IN    Anywhere').rows[0]).toEqual(['22/tcp', 'ALLOW IN', 'Anywhere']);
  });
  it('never presents denied output as successful records', () => {
    expect(inspectionData({ id: 'users', output: 'admin:1000:1000::/home/admin:/bin/bash', status: 'denied', truncated: false }).rows).toEqual([]);
  });
});
