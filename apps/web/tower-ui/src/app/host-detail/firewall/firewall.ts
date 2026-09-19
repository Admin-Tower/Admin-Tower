import { Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { HostSection } from '../../hosts/hosts.service';
import { FIREWALL_TOOLS, FirewallData, FirewallRule, FirewallScope, firewallData } from './firewall-data';

type SortKey = 'order' | 'chain' | 'action' | 'protocol' | 'source' | 'destination' | 'ports' | 'sourcePorts' | 'destinationPorts' | 'inputInterface' | 'outputInterface' | 'packets' | 'bytes';
@Component({
  selector: 'tower-firewall', imports: [FormsModule, MatButtonModule],
  templateUrl: './firewall.html', styleUrl: './firewall.scss',
})
export class Firewall {
  readonly sections = input.required<HostSection[]>();
  readonly busy = input(false);
  readonly canInspect = input(false);
  readonly inspect = output<void>();
  readonly tools = FIREWALL_TOOLS;
  readonly models = computed(() => this.tools.map(tool => firewallData(this.sections().find(s => s.id === tool.id) ?? { id: tool.id, output: '', status: 'not-collected', truncated: false })));
  readonly tool = signal('');
  readonly current = computed(() => this.models().find(m => m.section.id === this.tool()) ?? this.models().find(m => m.section.status === 'ok' && !m.problem && m.rules.length) ?? this.models().find(m => m.section.status === 'ok') ?? this.models()[0]);
  readonly grouped = computed(() => ['iptables', 'ip6tables'].includes(this.current().section.id));
  readonly showInterfaces = signal(false);
  readonly showCounters = signal(false);
  readonly collapsed = signal<string[]>([]);
  readonly history = signal<{ scope: string; action: string; query: string; page: number; expanded: number | null }[]>([]);
  readonly scope = signal('');
  readonly action = signal('');
  readonly query = signal('');
  readonly order = signal<{ key: SortKey; descending: boolean }>({ key: 'order', descending: false });
  readonly page = signal(0);
  readonly pageSize = signal(25);
  readonly expanded = signal<number | null>(null);
  readonly selectedScope = computed(() => this.current().scopes.find(s => s.key === this.scope()));
  readonly actions = computed(() => [...new Set(this.current().rules.map(r => r.action))].sort());
  readonly readable = computed(() => this.models().filter(m => m.section.status === 'ok').length);
  readonly rows = computed(() => {
    const terms = this.query().trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = this.current().rules.filter(r => (!this.scope() || r.scope === this.scope()) && (!this.action() || r.action === this.action()) && terms.every(term => [r.family, r.table, r.chain, r.action, r.source, r.destination, r.protocol, r.ports, r.comment, ...r.conditions, r.raw].join(' ').toLowerCase().includes(term)));
    const sort = this.order();
    return rows.sort((a, b) => {
      if (this.grouped() && a.scope !== b.scope) return this.current().scopes.findIndex(s => s.key === a.scope) - this.current().scopes.findIndex(s => s.key === b.scope);
      const comparison = sort.key === 'order' ? a.id - b.id : String(a[sort.key]).localeCompare(String(b[sort.key]), undefined, { numeric: true, sensitivity: 'base' });
      return comparison * (sort.descending ? -1 : 1);
    });
  });
  readonly pages = computed(() => Math.max(1, Math.ceil(this.rows().length / this.pageSize())));
  readonly currentPage = computed(() => Math.min(this.page(), this.pages() - 1));
  readonly visible = computed(() => this.rows().slice(this.currentPage() * this.pageSize(), (this.currentPage() + 1) * this.pageSize()));
  readonly groups = computed<{ scope: FirewallScope | null; rows: FirewallRule[]; matches: number }[]>(() => {
    if (!this.grouped()) return [{ scope: null, rows: this.visible(), matches: this.rows().length }];
    return this.current().scopes.filter(s => !this.scope() || this.scope() === s.key).map(scope => ({
      scope, rows: this.visible().filter(r => r.scope === scope.key),
      matches: this.rows().filter(r => r.scope === scope.key).length,
    })).filter(group => group.rows.length || (!this.query().trim() && !this.action() && this.currentPage() === 0 && !this.scopeCount(group.scope.key)));
  });
  readonly columns = computed(() => {
    if (!this.grouped()) return this.headers;
    const columns = this.headers.filter(h => h.key !== 'chain' && h.key !== 'ports');
    columns.push({ key: 'sourcePorts', label: 'Source port' }, { key: 'destinationPorts', label: 'Destination port' });
    if (this.showInterfaces()) columns.push({ key: 'inputInterface', label: 'In interface' }, { key: 'outputInterface', label: 'Out interface' });
    if (this.showCounters()) columns.push({ key: 'packets', label: 'Packets' }, { key: 'bytes', label: 'Bytes' });
    return columns;
  });
  readonly scopeKey = (scope: FirewallScope) => scope.key;
  match(value?: string) { return value ? value.replace(/^!= /, 'Except ') : '—'; }
  targetScope(row: FirewallRule) { return row.target ? this.current().scopes.find(s => s.family === row.family && s.table === row.table && s.name === row.target) : undefined; }
  follow(row: FirewallRule) {
    const target = this.targetScope(row); if (!target) return;
    this.history.update(h => [...h, { scope: this.scope(), action: this.action(), query: this.query(), page: this.currentPage(), expanded: this.expanded() }]);
    this.scope.set(target.key); this.action.set(''); this.query.set(''); this.resetPage();
    this.collapsed.update(keys => keys.filter(k => k !== target.key));
  }
  back() {
    const previous = this.history()[this.history().length - 1]; if (!previous) return;
    this.history.update(h => h.slice(0, -1));
    this.scope.set(previous.scope); this.action.set(previous.action); this.query.set(previous.query); this.page.set(previous.page); this.expanded.set(previous.expanded);
  }
  toggleChain(key: string) { this.collapsed.update(keys => keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key]); }

  readonly headers: { key: SortKey; label: string }[] = [
    { key: 'order', label: 'Order' }, { key: 'chain', label: 'Chain / zone' }, { key: 'action', label: 'Action' }, { key: 'protocol', label: 'Protocol' }, { key: 'source', label: 'Source' }, { key: 'destination', label: 'Destination' }, { key: 'ports', label: 'Port / service' },
  ];
  choose(id: string) { this.history.set([]); this.tool.set(id); this.clear(); this.order.set({ key: 'order', descending: false }); }
  clear() { this.scope.set(''); this.action.set(''); this.query.set(''); this.resetPage(); }
  resetPage() { this.page.set(0); this.expanded.set(null); }
  chooseScope(value: string) { this.scope.set(value); this.resetPage(); }
  sort(key: SortKey) { this.order.set({ key, descending: this.order().key === key ? !this.order().descending : false }); this.resetPage(); }
  restoreOrder() { this.order.set({ key: 'order', descending: false }); this.resetPage(); }
  scopeCount(key: string) { return this.current().rules.filter(r => r.scope === key).length; }
  toggle(row: FirewallRule) { this.expanded.set(this.expanded() === row.id ? null : row.id); }
  status(model: FirewallData) {
    if (model.section.status === 'ok') return model.problem || model.section.truncated || model.diagnostics.length ? 'Partial data' : 'Available';
    return ({ denied: 'Permission required', unavailable: 'Not installed', timeout: 'Timed out', error: 'Inspection failed', 'not-collected': 'Not collected' } as Record<string, string>)[model.section.status] ?? 'Unavailable';
  }
  reason(model: FirewallData) {
    return ({ denied: 'This SSH account cannot read this firewall configuration. Review a privileged inspection to collect it with sudo.', unavailable: 'This firewall tool is not installed. That does not establish whether another tool manages the host firewall.', timeout: 'The inspection exceeded its time limit. The host’s firewall state is unknown from this result.', error: 'The tool could not read its configuration. See the diagnostic details below.', 'not-collected': 'This source is missing from the snapshot. Refresh the host to collect it.' } as Record<string, string>)[model.section.status] ?? model.problem;
  }
  tone(action: string) { return /^(ACCEPT|ALLOW)$/i.test(action) ? 'allow' : /^(DROP|DENY|REJECT)$/i.test(action) ? 'deny' : 'other'; }
}
