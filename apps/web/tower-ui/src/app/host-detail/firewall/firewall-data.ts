import { HostSection } from '../../hosts/hosts.service';
import { inspectionData } from '../inspection-data';

export const FIREWALL_TOOLS = [
  { id: 'nftables', label: 'nftables', description: 'Kernel ruleset' },
  { id: 'iptables', label: 'iptables · IPv4', description: 'IPv4 rules and policies' },
  { id: 'ip6tables', label: 'iptables · IPv6', description: 'IPv6 rules and policies' },
  { id: 'ufw', label: 'UFW', description: 'UFW configuration' },
  { id: 'firewalld', label: 'firewalld', description: 'Runtime zones' },
];
export interface FirewallScope { key: string; family: string; table: string; name: string; policy: string; hook: string; priority: string; attributes: [string, string][] }
export interface FirewallRule {
  id: number; order: number; scope: string; family: string; table: string; chain: string;
  action: string; protocol: string; source: string; destination: string; ports: string;
  inputInterface?: string; outputInterface?: string; sourcePorts?: string; destinationPorts?: string; packets?: string; bytes?: string; target?: string;
  handle: string; comment: string; conditions: string[]; counters: string; raw: string;
}
export interface FirewallData {
  section: HostSection; label: string; scopes: FirewallScope[]; rules: FirewallRule[];
  properties: [string, string][]; objects: { name: string; type: string; context: string; raw: string }[];
  diagnostics: string[]; problem: string;
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const json = (value: unknown) => JSON.stringify(value, null, 2) ?? '';
const key = (family: string, table: string, name: string) => JSON.stringify([family, table, name]);

function scope(data: FirewallData, family: string, table: string, name: string): FirewallScope {
  const id = key(family, table, name);
  let value = data.scopes.find(s => s.key === id);
  if (!value) { value = { key: id, family, table, name, policy: '', hook: '', priority: '', attributes: [] }; data.scopes.push(value); }
  return value;
}
function rule(data: FirewallData, parent: FirewallScope, raw: string): FirewallRule {
  const value: FirewallRule = { id: data.rules.length + 1, order: data.rules.filter(r => r.scope === parent.key).length + 1, scope: parent.key, family: parent.family, table: parent.table, chain: parent.name, action: 'No explicit verdict', protocol: '', source: '', destination: '', ports: '', handle: '', comment: '', conditions: [], counters: '', raw };
  data.rules.push(value); return value;
}

/** Render expressions without discarding unfamiliar syntax or claiming a verdict. */
function expression(value: unknown, depth = 0): string {
  if (depth > 12) return JSON.stringify(value);
  if (value === null || typeof value !== 'object') return string(value);
  if (Array.isArray(value)) return value.map(v => expression(v, depth + 1)).join(', ');
  const item = record(value);
  if ('prefix' in item) { const p = record(item['prefix']); return `${expression(p['addr'], depth + 1)}/${string(p['len'])}`; }
  if ('set' in item) return `{ ${expression(item['set'], depth + 1)} }`;
  if (Array.isArray(item['range'])) return item['range'].map(v => expression(v, depth + 1)).join('–');
  for (const type of ['payload', 'meta', 'ct']) {
    if (type in item) { const p = record(item[type]); return [string(p['protocol']) || type, string(p['field']) || string(p['key'])].filter(Boolean).join(' '); }
  }
  return JSON.stringify(value);
}
function nft(data: FirewallData) {
  let document: Record<string, unknown>;
  try { document = record(JSON.parse(data.section.output)); }
  catch { data.problem = 'Structured nftables data is unavailable. Refresh this host to collect JSON; truncated or older snapshots remain available under Original output.'; return; }
  if (!Array.isArray(document['nftables'])) { data.problem = 'The host returned an unrecognized nftables document.'; return; }
  const entries = document['nftables'];
  for (const entry of entries) {
    const value = record(record(entry)['chain']);
    if (!Object.keys(value).length) continue;
    if (!['family', 'table', 'name'].every(k => typeof value[k] === 'string')) { data.diagnostics.push(json(entry)); continue; }
    const parent = scope(data, string(value['family']), string(value['table']), string(value['name']));
    parent.policy = string(value['policy']); parent.hook = string(value['hook']); parent.priority = string(value['prio']);
    parent.attributes = Object.entries(value).filter(([k]) => !['family', 'table', 'name', 'policy', 'hook', 'prio'].includes(k)).map(([k, v]) => [k, expression(v)]);
  }
  for (const entry of entries) {
    const item = record(entry);
    if ('metainfo' in item || 'chain' in item) continue;
    if (!('rule' in item)) {
      const [type, object] = Object.entries(item)[0] ?? [];
      if (!type) { data.diagnostics.push(json(entry)); continue; }
      const obj = record(object);
      data.objects.push({ type, name: string(obj['name']) || type, context: [string(obj['family']), string(obj['table'])].filter(Boolean).join(' / '), raw: json(entry) });
      continue;
    }
    const value = record(item['rule']);
    if (!['family', 'table', 'chain'].every(k => typeof value[k] === 'string') || !Array.isArray(value['expr'])) { data.diagnostics.push(json(entry)); continue; }
    const parent = scope(data, string(value['family']), string(value['table']), string(value['chain']));
    const row = rule(data, parent, json(entry));
    row.comment = string(value['comment']); row.handle = string(value['handle']);
    for (const statement of value['expr']) {
      const part = record(statement);
      if ('match' in part) {
        const match = record(part['match']), left = record(match['left']), payload = record(left['payload']);
        const op = string(match['op']);
        const right = `${op === '==' ? '' : op + ' '}${expression(match['right'])}`;
        row.conditions.push(`${expression(match['left'])} ${op} ${expression(match['right'])}`);
        const field = string(payload['field']);
        if (field === 'saddr') row.source = [row.source, right].filter(Boolean).join(' AND ');
        if (field === 'daddr') row.destination = [row.destination, right].filter(Boolean).join(' AND ');
        if (['sport', 'dport'].includes(field)) {
          row.ports = [row.ports, `${field === 'sport' ? 'Source' : 'Destination'} ${right}`].filter(Boolean).join('; ');
          row.protocol = string(payload['protocol']);
        }
        if (record(left['meta'])['key'] === 'l4proto') row.protocol = right;
      } else if ('counter' in part) {
        const counter = record(part['counter']);
        row.counters = typeof part['counter'] === 'string' ? `Named counter: ${part['counter']}` : `${string(counter['packets']) || 'Not reported'} packets · ${string(counter['bytes']) || 'not reported'} bytes`;
      } else {
        const verdict = ['accept', 'drop', 'reject', 'return', 'jump', 'goto', 'dnat', 'snat', 'masquerade', 'redirect', 'queue'].find(k => k in part);
        if (verdict) {
          const target = string(record(part[verdict])['target']);
          row.action = verdict.toUpperCase() + (target ? ` → ${target}` : '');
        }
        row.conditions.push(expression(statement));
      }
    }
  }
}

/** Tokenize saved iptables syntax only; these strings are never executed. */
function tokens(line: string): string[] | null {
  const values: string[] = []; let value = '', quote = '', escaped = false, started = false;
  for (const char of line) {
    if (escaped) { value += char; escaped = false; started = true; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; else value += char; started = true; continue; }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/\s/.test(char)) { if (started) { values.push(value); value = ''; started = false; } }
    else { value += char; started = true; }
  }
  if (quote || escaped) return null;
  if (started) values.push(value);
  return values;
}
function iptables(data: FirewallData) {
  let table = ''; const family = data.section.id === 'iptables' ? 'IPv4' : 'IPv6';
  for (const line of data.section.output.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (line.startsWith('*')) { table = line.slice(1); continue; }
    if (line === 'COMMIT') { table = ''; continue; }
    const policy = line.match(/^:(\S+)\s+(\S+)\s+\[(\d+):(\d+)\]$/);
    if (policy && table) { const parent = scope(data, family, table, policy[1]); parent.policy = policy[2] === '-' ? '' : policy[2]; parent.attributes.push(['Counter', `${policy[3]} packets · ${policy[4]} bytes`]); continue; }
    const counter = line.match(/^\[(\d+):(\d+)\]\s+/);
    const args = tokens(counter ? line.slice(counter[0].length) : line);
    if (!args || args[0] !== '-A' || !args[1] || !table) { data.diagnostics.push(line); continue; }
    const row = rule(data, scope(data, family, table, args[1]), line);
    const options = new Map<string, string>();
    const valued = new Set(['-p', '--protocol', '-s', '--source', '-d', '--destination', '-i', '--in-interface', '-o', '--out-interface', '-j', '--jump', '-g', '--goto', '-m', '--match', '--comment', '--sport', '--sports', '--source-port', '--source-ports', '--dport', '--dports', '--destination-port', '--destination-ports']);
    for (let index = 2; index < args.length; index++) {
      let inverted = args[index] === '!';
      if (inverted) index++;
      const name = args[index];
      if (!name?.startsWith('-')) continue;
      if (args[index + 1] === '!') { inverted = true; index++; }
      const value = args[index + 1];
      if (value !== undefined && (valued.has(name) || (!value.startsWith('-') && value !== '!'))) {
        options.set(name, (inverted ? '!= ' : '') + value); index++;
      }
    }
    const option = (...names: string[]) => names.map(name => options.get(name)).find(value => value !== undefined) ?? '';
    row.protocol = option('-p', '--protocol'); row.source = option('-s', '--source'); row.destination = option('-d', '--destination');
    row.inputInterface = option('-i', '--in-interface'); row.outputInterface = option('-o', '--out-interface');
    row.sourcePorts = option('--sport', '--sports', '--source-port', '--source-ports');
    row.destinationPorts = option('--dport', '--dports', '--destination-port', '--destination-ports');
    row.ports = [['Source', option('--sport', '--sports', '--source-port', '--source-ports')], ['Destination', option('--dport', '--dports', '--destination-port', '--destination-ports')]].filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join('; ');
    const target = option('-j', '--jump'), go = option('-g', '--goto');
    row.target = go || target;
    row.action = go ? `GOTO → ${go}` : target ? (['ACCEPT', 'DROP', 'REJECT', 'RETURN', 'LOG', 'DNAT', 'SNAT', 'MASQUERADE', 'REDIRECT', 'MARK', 'NFQUEUE'].includes(target) ? target : `JUMP → ${target}`) : 'No explicit verdict';
    row.comment = option('--comment'); row.conditions = [line];
    if (counter) { row.packets = counter[1]; row.bytes = counter[2]; row.counters = `${counter[1]} packets · ${counter[2]} bytes`; }
  }
  for (const row of data.rules) {
    if (row.action.startsWith('JUMP → ') && !data.scopes.some(s => s.key === key(row.family, row.table, row.target ?? ''))) row.action = row.target ?? row.action;
  }
}
function ufw(data: FirewallData) {
  const parsed = inspectionData(data.section);
  data.diagnostics = parsed.unparsed.filter(line => !/^(Status|Logging|Default|New profiles):/.test(line));
  for (const line of data.section.output.split('\n')) {
    const property = line.match(/^(Status|Logging|Default|New profiles):\s*(.*)$/);
    if (property) data.properties.push([property[1], property[2]]);
  }
  for (const [destination, action, source] of parsed.rows) {
    const family = /\(v6\)/.test(destination + source) ? 'IPv6' : 'IPv4';
    const direction = /\bOUT\b/.test(action) ? 'Outgoing' : /\bFWD\b/.test(action) ? 'Forwarded' : 'Incoming';
    const row = rule(data, scope(data, family, 'UFW', direction), `${destination}  ${action}  ${source}`);
    row.action = action.split(' ')[0]; row.source = source; row.destination = destination;
    row.protocol = destination.match(/\/(tcp|udp)\b/)?.[1] ?? '';
    row.ports = destination.match(/\b[\d,:]+\/(?:tcp|udp)\b/)?.[0] ?? '';
    row.conditions = [`${direction}: ${source} → ${destination}`];
  }
}
function firewalld(data: FirewallData) {
  let current: FirewallScope | undefined, rich = false;
  for (const line of data.section.output.split('\n')) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) { current = scope(data, '', 'Zone', line.trim()); rich = false; continue; }
    if (!current) { data.diagnostics.push(line); continue; }
    if (rich && /^\s+rule\s/.test(line)) { const row = rule(data, current, line.trim()); row.action = 'Rich rule'; row.conditions = [line.trim()]; continue; }
    const property = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (!property) { data.diagnostics.push(line); continue; }
    const [, name, value] = property; rich = name === 'rich rules';
    current.attributes.push([name, value || '—']);
    if (name === 'target') current.policy = value;
    if (['services', 'ports', 'protocols', 'source-ports', 'forward-ports'].includes(name)) {
      for (const item of value.split(/\s+/).filter(Boolean)) {
        const row = rule(data, current, `${name}: ${item}`);
        row.action = ({ services: 'Service', ports: 'Port', protocols: 'Protocol', 'source-ports': 'Source port', 'forward-ports': 'Forward port' } as Record<string, string>)[name];
        row.ports = item; row.protocol = item.match(/\/(tcp|udp|sctp)\b/)?.[1] ?? '';
        row.conditions = [`${name}: ${item}`];
      }
    }
  }
}
export function firewallData(section: HostSection): FirewallData {
  const data: FirewallData = { section, label: FIREWALL_TOOLS.find(t => t.id === section.id)?.label ?? section.id, scopes: [], rules: [], properties: [], objects: [], diagnostics: [], problem: '' };
  if (section.status !== 'ok') return data;
  try {
    if (section.id === 'nftables') nft(data);
    else if (['iptables', 'ip6tables'].includes(section.id)) iptables(data);
    else if (section.id === 'ufw') ufw(data);
    else if (section.id === 'firewalld') firewalld(data);
  } catch {
    data.problem = 'This output could not be interpreted safely. Inspect Original output for the captured configuration.';
    data.rules = []; data.scopes = []; data.objects = [];
  }
  return data;
}
