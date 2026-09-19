import { HostSection } from '../hosts/hosts.service';

export interface InspectionColumn { label: string; kind?: 'number' | 'size' | 'state' | 'time' }
export interface InspectionData {
  columns: InspectionColumn[];
  rows: string[][];
  unparsed: string[];
  note?: string;
  sort?: { column: number; descending: boolean };
}
const columns = (...labels: string[]): InspectionColumn[] => labels.map(label => ({ label }));
const number = (label: string): InspectionColumn => ({ label, kind: 'number' });
const size = (label: string): InspectionColumn => ({ label, kind: 'size' });
const state = (label: string): InspectionColumn => ({ label, kind: 'state' });

/** Parse only known formats. Unrecognized lines remain available in diagnostics. */
export function inspectionData(section: HostSection): InspectionData {
  const result: InspectionData = { columns: [], rows: [], unparsed: [] };
  if (section.status !== 'ok') return result;
  const lines = section.output.split('\n');
  let parse: (line: string, index: number) => string[] | null;
  switch (section.id) {
    case 'users':
      result.columns = [ ...columns('User'), number('UID'), number('Primary GID'), ...columns('Description', 'Home', 'Shell') ];
      parse = line => { const fields = line.split(':'); return fields.length === 6 && /^\d+$/.test(fields[1]) && /^\d+$/.test(fields[2]) ? fields : null; };
      break;
    case 'groups':
      result.columns = [ ...columns('Group'), number('GID'), ...columns('Supplementary members') ];
      parse = line => { const fields = line.split(':'); return fields.length === 3 && /^\d+$/.test(fields[1]) ? [fields[0], fields[1], fields[2].split(',').filter(Boolean).join(', ')] : null; };
      result.note = 'Primary group membership is listed by GID in the Users table.';
      break;
    case 'processes':
      result.columns = [number('PID'), number('Parent PID'), ...columns('User'), number('CPU %'), number('Memory %'), state('State'), ...columns('Process')];
      result.sort = { column: 3, descending: true };
      parse = line => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.+)$/)?.slice(1) ?? null;
      result.note = 'CPU % is the process lifetime average reported by ps. Command arguments are not collected.';
      break;
    case 'services': case 'failedServices':
      result.columns = [...columns('Service'), state('Load'), state('Active'), state('Substate'), ...columns('Description')];
      parse = line => line.trim().replace(/^[●×]\s*/, '').match(/^(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/)?.slice(1).map(s => s ?? '') ?? null;
      break;
    case 'serviceFiles':
      result.columns = [...columns('Service'), state('Boot state'), ...columns('Preset')];
      parse = line => { const m = line.trim().match(/^(\S+\.service)\s+(\S+)(?:\s+(\S+))?$/); return m ? [m[1], m[2], m[3] ?? ''] : null; };
      break;
    case 'storage':
      result.columns = [...columns('Filesystem', 'Type'), size('Size'), size('Used'), size('Available'), number('Used %'), ...columns('Mount point')];
      parse = line => line.trim().match(/^(\S+)\s+(\S+)\s+([\d.]+[KMGTPEZY]?)\s+([\d.]+[KMGTPEZY]?)\s+([\d.]+[KMGTPEZY]?)\s+(\d+%)\s+(.+)$/)?.slice(1) ?? null;
      break;
    case 'disks':
      result.columns = [...columns('Device', 'Type'), size('Size'), ...columns('Filesystem', 'Mount point')];
      parse = line => {
        const pairs = [...line.matchAll(/([A-Z]+)="([^"\n]*)"/g)];
        if (pairs.length !== 5 || pairs.map(m => m[0]).join(' ') !== line.trim()) return null;
        const fields = Object.fromEntries(pairs.map(m => [m[1], m[2].replace(/\\x([0-9a-f]{2})/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))]));
        return ['NAME', 'TYPE', 'SIZE', 'FSTYPE', 'MOUNTPOINT'].every(key => key in fields) ? ['NAME', 'TYPE', 'SIZE', 'FSTYPE', 'MOUNTPOINT'].map(key => fields[key]) : null;
      };
      break;
    case 'interfaces':
      result.columns = [...columns('Interface'), state('State'), ...columns('Addresses')];
      parse = line => { const m = line.trim().match(/^(\S+)\s+(UP|DOWN|UNKNOWN|DORMANT|LOWERLAYERDOWN|NOTPRESENT|TESTING)(?:\s+(.*))?$/); return m ? [m[1], m[2], m[3] ?? ''] : null; };
      break;
    case 'routes': case 'routes6':
      result.columns = columns('Destination', 'Gateway', 'Interface', 'Type', 'Details');
      parse = line => {
        const tokens = line.trim().split(/\s+/);
        const types = ['local', 'broadcast', 'unreachable', 'blackhole', 'prohibit', 'throw', 'multicast', 'anycast', 'unicast'];
        const type = types.includes(tokens[0]) ? tokens.shift() ?? 'unicast' : 'unicast';
        const destination = tokens.shift() ?? '';
        if (!/^(default|[0-9a-fA-F.:]+(?:\/\d+)?)$/.test(destination)) return null;
        const option = (key: string) => { const index = tokens.indexOf(key); return index >= 0 ? tokens[index + 1] ?? '' : ''; };
        return [destination, option('via'), option('dev'), type, tokens.join(' ')];
      };
      result.note = 'Details retain all route attributes, including multipath information.';
      break;
    case 'ports':
      result.columns = [...columns('Protocol'), state('State'), number('Receive queue'), number('Send queue'), ...columns('Local address', 'Peer address', 'Process')];
      parse = line => { const m = line.trim().match(/^(tcp|udp|tcp6|udp6)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/); return m ? m.slice(1).map(s => s ?? '') : null; };
      break;
    case 'logs':
      result.columns = [{ label: 'Timestamp', kind: 'time' }, ...columns('Host', 'Source', 'Message')];
      result.sort = { column: 0, descending: true };
      parse = line => {
        const m = line.match(/^(\d{4}-\d{2}-\d{2}T\S+)\s+(\S+)\s+(\S+?)(?::\s|\s)(.*)$/);
        if (m) return m.slice(1);
        if (/^\s+\S/.test(line) && result.rows.length) { result.rows[result.rows.length - 1][3] += '\n' + line.trim(); return []; }
        return null;
      };
      result.note = 'Up to 150 journal entries. Search by source or message; timestamps retain the host’s time zone.';
      break;
    case 'iptables': case 'ip6tables': {
      result.columns = [number('Order'), ...columns('Table', 'Chain', 'Entry', 'Rule / policy')];
      let table = '';
      parse = (line, index) => {
        if (line.startsWith('*')) { table = line.slice(1); return []; }
        if (line === 'COMMIT' || line.startsWith('#')) return [];
        const policy = line.match(/^:(\S+)\s+(.+)$/);
        if (policy) return [String(index + 1), table, policy[1], 'Policy', policy[2]];
        const rule = line.match(/^-A\s+(\S+)\s+(.+)$/);
        return rule ? [String(index + 1), table, rule[1], 'Rule', line] : null;
      };
      result.note = 'Order refers to the original output. Filtering or sorting does not change firewall evaluation order. Rules are shown in full.';
      break;
    }
    case 'nftables':
      result.columns = [number('Line'), ...columns('Ruleset')];
      parse = (line, index) => [String(index + 1), line];
      result.note = 'nftables declarations can span multiple lines. Line numbers preserve context; use Original output to read the complete ruleset in order.';
      break;
    case 'ufw':
      result.columns = columns('To', 'Action', 'From');
      parse = line => {
        const m = line.trim().match(/^(.+?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)(?:\s+(IN|OUT|FWD))?\s{2,}(.+)$/);
        return m ? [m[1], [m[2], m[3]].filter(Boolean).join(' '), m[4]] : null;
      };
      result.note = lines.find(l => l.startsWith('Status:')) ?? 'UFW rules';
      break;
    case 'firewalld': {
      result.columns = columns('Zone', 'Property', 'Value');
      let zone = '';
      parse = line => { if (!/^\s/.test(line)) { zone = line; return []; } const m = line.trim().match(/^([^:]+):\s*(.*)$/); return m ? [zone, m[1], m[2]] : null; };
      break;
    }
    case 'system': case 'cpu':
      result.columns = columns('Property', 'Value');
      parse = line => { const m = line.match(/^([^:=]+)[:=]\s*(.+)$/); return m ? [m[1].trim(), m[2].replace(/^"|"$/g, '')] : null; };
      break;
    default:
      return { ...result, unparsed: lines };
  }
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    if (/^\s*(PID\s+PPID\s+USER|Filesystem\s+Type|Netid\s+State|NAME\s+TYPE|To\s+Action\s+From|-- No entries --|Memory \(KiB\):)/.test(line) || /^[-\s]+$/.test(line)) return;
    if (section.id === 'ufw' && line.startsWith('Status:')) return;
    const row = parse(line, index);
    if (row === null) result.unparsed.push(line);
    else if (row.length) result.rows.push(row);
  });
  return result;
}

export function compareCells(a: string, b: string, kind?: InspectionColumn['kind']): number {
  if (kind === 'time') {
    const left = Date.parse(a), right = Date.parse(b);
    if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
  }
  if (kind === 'number' || kind === 'size') {
    const value = (text: string) => {
      if (kind === 'number') return Number(text.replace(/%$/, ''));
      const match = text.match(/^([\d.]+)([KMGTPEZY]?)(?:i?B)?$/i);
      return match ? Number(match[1]) * 1024 ** (match[2] ? 'KMGTPEZY'.indexOf(match[2].toUpperCase()) + 1 : 0) : NaN;
    };
    const left = a === '' ? NaN : value(a), right = b === '' ? NaN : value(b);
    if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
    if (Number.isFinite(left)) return -1;
    if (Number.isFinite(right)) return 1;
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}
