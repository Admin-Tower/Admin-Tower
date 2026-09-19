import { afterNextRender, Component, DestroyRef, Injector, computed, inject, signal } from '@angular/core';
import { DOCUMENT, DatePipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { Accounts } from './accounts/accounts';
import { Firewall } from './firewall/firewall';
import { InspectionTable } from './inspection-table/inspection-table';
import { ActionReview, Host, HostAction, HostOperation, HostOverview, HostsService, Terminal } from '../hosts/hosts.service';

@Component({
  selector: 'tower-host-detail',
  imports: [DatePipe, RouterLink, FormsModule, MatButtonModule, InspectionTable, Firewall, Accounts],
  templateUrl: './host-detail.html', styleUrl: './host-detail.scss',
})
export class HostDetail {
  readonly service = inject(HostsService);
  private readonly destroyRef = inject(DestroyRef);
  readonly host = signal<Host | null>(null);
  readonly overview = signal<HostOverview | null>(null);
  readonly terminals = signal<Terminal[]>([]);
  readonly review = signal<ActionReview | null>(null);
  readonly operation = signal<HostOperation | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly tab = signal('system');
  readonly accountActions = signal(false);
  readonly serviceActions = signal(false);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  terminal = '';
  username = '';
  group = '';
  member = '';
  membershipGroup = '';
  membershipAdd = true;
  unit = '';
  verb: 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable' = 'restart';
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  readonly tabs = [
    { id: 'system', label: 'Overview', sections: ['system', 'cpu'] },
    { id: 'network', label: 'Networking', sections: ['interfaces', 'routes', 'routes6', 'ports'] },
    { id: 'storage', label: 'Storage', sections: ['storage', 'disks'] },
    { id: 'processes', label: 'Processes', sections: ['processes'] },
    { id: 'accounts', label: 'Users & groups', sections: ['users', 'groups'] },
    { id: 'services', label: 'Services', sections: ['services', 'serviceFiles', 'failedServices'] },
    { id: 'logs', label: 'Logs', sections: ['logs'] },
    { id: 'firewall', label: 'Firewall', sections: ['nftables', 'iptables', 'ip6tables', 'ufw', 'firewalld'] },
  ];
  readonly labels: Record<string, string> = {
    system: 'Operating system & resources', cpu: 'CPU', interfaces: 'Addresses & interfaces', routes: 'IPv4 routes', routes6: 'IPv6 routes', ports: 'Listening sockets',
    storage: 'Filesystem capacity', disks: 'Block devices', processes: 'Processes', users: 'Users', groups: 'Groups',
    services: 'Loaded services', serviceFiles: 'Service startup', failedServices: 'Failed services', logs: 'Journal',
    nftables: 'nftables ruleset', iptables: 'IPv4 iptables rules', ip6tables: 'IPv6 iptables rules', ufw: 'UFW status', firewalld: 'firewalld zones',
  };
  readonly facts = computed(() => {
    const output = this.overview()?.sections.find(s => s.id === 'system' && s.status === 'ok')?.output ?? '';
    const value = (prefix: string) => output.split('\n').find(l => l.startsWith(prefix))?.slice(prefix.length).trim().replace(/^"|"$/g, '') ?? 'Unavailable';
    const total = Number.parseInt(value('MemTotal:'));
    const available = Number.parseInt(value('MemAvailable:'));
    return [
      { label: 'Operating system', value: value('PRETTY_NAME=') },
      { label: 'Hostname', value: value('Hostname:') },
      { label: 'Kernel', value: value('Kernel:') },
      { label: 'Uptime', value: value('Uptime:') },
      { label: 'Logical CPUs', value: value('Logical CPUs:') },
      { label: 'Load · 1 / 5 / 15 min', value: value('Load:').split(/\s+/).slice(0, 3).join(' / ') },
      { label: 'Memory used / total', value: Number.isFinite(total) && Number.isFinite(available) && total > 0 ? `${((total - available) / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} GiB` : 'Unavailable' },
    ];
  });
  readonly sections = computed(() => this.overview()?.sections.filter(s => this.tabs.find(t => t.id === this.tab())?.sections.includes(s.id)) ?? []);
  readonly locked = computed(() => this.busy() || this.operation()?.state === 'running');
  readonly canChange = computed(() => !!this.overview()?.supported && !this.locked());
  readonly users = computed(() => this.names('users'));
  readonly groups = computed(() => this.names('groups'));
  readonly units = computed(() => [...new Set((this.overview()?.sections.filter(s => ['services', 'serviceFiles', 'failedServices'].includes(s.id) && s.status === 'ok') ?? []).flatMap(s => s.output.split('\n').map(l => l.trim().replace(/^[●×]\s*/, '').split(/\s+/)[0]).filter(u => u.endsWith('.service'))))].sort());

  constructor() {
    this.destroyRef.onDestroy(() => { ++this.generation; clearTimeout(this.timer); });
    inject(ActivatedRoute).paramMap.pipe(takeUntilDestroyed()).subscribe(params => {
      const generation = ++this.generation;
      clearTimeout(this.timer);
      this.host.set(null); this.overview.set(null); this.review.set(null); this.operation.set(null); this.error.set('');
      this.username = this.group = this.member = this.membershipGroup = this.unit = '';
      if (this.service.desktop) void this.load(params.get('id') ?? '', generation);
    });
  }
  rowAction(id: string) {
    return id === 'users' ? 'Manage groups' : id === 'groups' ? 'Manage members' : ['services', 'serviceFiles', 'failedServices'].includes(id) ? 'Manage' : '';
  }
  selectRow(id: string, row: string[]) {
    if (!this.canChange()) return;
    if (id === 'users' || id === 'groups') {
      if (id === 'users') this.member = row[0]; else this.membershipGroup = row[0];
      this.accountActions.set(true);
    } else { this.unit = row[0]; this.serviceActions.set(true); }
    const editor = this.document.getElementById(id === 'users' || id === 'groups' ? 'account-editor' : 'service-editor');
    editor?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    editor?.querySelector('summary')?.focus();
  }
  private names(id: string) {
    return (this.overview()?.sections.find(s => s.id === id && s.status === 'ok')?.output ?? '').split('\n').map(l => l.split(':')[0]).filter(Boolean);
  }
  private async load(id: string, generation: number) {
    this.busy.set(true);
    try {
      const [hosts, terminals] = await Promise.all([this.service.list(), this.service.terminals()]);
      if (generation !== this.generation) return;
      const host = hosts.find(h => h.id === id);
      if (!host) throw new Error('This host is no longer in the inventory.');
      this.host.set(host); this.terminals.set(terminals); this.terminal = terminals[0]?.id ?? '';
      const snapshot = await this.service.inspect(id);
      if (generation === this.generation) this.applySnapshot(snapshot);
    } catch (error) { if (generation === this.generation) this.error.set(this.message(error)); }
    finally { if (generation === this.generation) this.busy.set(false); }
  }
  async refresh() {
    const host = this.host();
    if (!host || this.locked()) return;
    await this.perform(async generation => {
      const snapshot = await this.service.inspect(host.id);
      if (generation === this.generation) { this.applySnapshot(snapshot); this.review.set(null); }
    });
  }
  async prepare(action: HostAction) {
    const host = this.host();
    if (!host || this.locked() || (action.kind !== 'inspect' && !this.canChange())) return;
    this.review.set(null);
    await this.perform(async generation => {
      const review = await this.service.review(host.id, action);
      if (generation === this.generation) {
        this.review.set(review);
        afterNextRender(() => {
          const heading = this.document.getElementById('review-heading');
          heading?.scrollIntoView?.({ behavior: 'smooth', block: 'center' }); heading?.focus({ preventScroll: true });
        }, { injector: this.injector });
      }
    });
  }
  async execute() {
    const review = this.review();
    if (!review || !this.terminal || this.locked()) return;
    await this.perform(async generation => {
      this.review.set(null);
      const job = await this.service.start(review.id, this.terminal);
      if (generation !== this.generation) return;
      this.accept(job);
      if (job.state === 'running') this.schedule(job, generation);
    });
  }
  private schedule(job: HostOperation, generation: number) {
    this.timer = setTimeout(async () => {
      try {
        const next = await this.service.operation(job.hostId, job.id);
        if (generation !== this.generation) return;
        this.accept(next);
        if (next.state === 'running') this.schedule(next, generation);
      } catch (error) {
        if (generation !== this.generation) return;
        this.error.set(this.message(error));
        this.operation.set({ ...job, state: 'unknown', message: 'Could not read the result. Check the external terminal and refresh before another action.' });
      }
    }, 1000);
  }
  private accept(job: HostOperation) {
    this.operation.set(job);
    if (job.overview) this.applySnapshot(job.overview);
  }
  private applySnapshot(snapshot: HostOverview) {
    this.overview.set(snapshot);
    if (snapshot.target && snapshot.target.id === this.host()?.id) this.host.set(snapshot.target);
  }
  private async perform(work: (generation: number) => Promise<void>) {
    const generation = this.generation;
    this.busy.set(true); this.error.set('');
    try { await work(generation); }
    catch (error) { if (generation === this.generation) this.error.set(this.message(error)); }
    finally { if (generation === this.generation) this.busy.set(false); }
  }
  private message(error: unknown) { return error instanceof Error ? error.message : typeof error === 'string' ? error : 'The host operation did not complete.'; }
}
