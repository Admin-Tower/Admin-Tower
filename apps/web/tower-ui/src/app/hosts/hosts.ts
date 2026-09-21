import { RebootRun, RebootsService } from '../automation/reboot/reboots.service';
import { AutomationRunner } from '../automation/automation-runner.service';
import { InventorySelection } from './inventory-selection.service';
import { AutomationService, HostGroup, PingRun } from '../automation/automation.service';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { NgTemplateOutlet } from '@angular/common';
import { Clipboard } from '@angular/cdk/clipboard';
import { afterNextRender, Component, DestroyRef, ElementRef, Injector, computed, effect, inject, OnInit, signal, untracked } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MAT_TOOLTIP_DEFAULT_OPTIONS, MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Host, HostsService, IdentityOptions, Terminal } from './hosts.service';

@Component({
  selector: 'tower-hosts',
  providers: [{ provide: MAT_TOOLTIP_DEFAULT_OPTIONS, useFactory: () => ({ ...inject(MAT_TOOLTIP_DEFAULT_OPTIONS, { skipSelf: true }), disableTooltipInteractivity: true }) }],
  imports: [ RouterLink, NgTemplateOutlet, ReactiveFormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatTooltipModule],
  templateUrl: './hosts.html',
  styleUrl: './hosts.scss'
})
export class Hosts implements OnInit {
  private readonly clipboard = inject(Clipboard);
  private readonly snackBar = inject(MatSnackBar);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private systemQueue: Host[] = [];
  private activeInspections = 0;
  private readonly activeSystemRequests = new Set<string>();
  readonly automation = inject(AutomationService);
  readonly pingRun = signal<PingRun | null>(null);
  readonly pingError = signal('');
  readonly pingLoaded = signal(false);
  readonly expandedPing = signal<string | null>(null);
  private pingTimer?: ReturnType<typeof setTimeout>;
  private pingRevision = 0;
  readonly pingStatuses = computed(() => {
    const results = this.selection.pingResults();
    return new Map(this.hosts().map(host => {
      const result = results.get(host.id);
      // A rename does not invalidate an SSH/Python reachability result.
      const connection = ({ settings }: Host) => {
        const auth = settings.authentication;
        return JSON.stringify([settings.address, settings.port, settings.username, auth.kind,
          auth.kind === 'agent' ? auth.fingerprint : auth.filename]);
      };
      const changed = result && connection(result.host) !== connection(host);
      const error = this.pingError() && (!this.pingRun() || this.pingRun()?.results.some(r => r.host.id === host.id)) ? this.pingError() : '';
      const outcome = error ? 'unavailable' : changed ? 'changed' : result?.outcome ?? (this.pingLoaded() ? 'unchecked' : 'loading');
      const labels: Record<string, string> = {
        waiting: 'Waiting', successful: 'Passed', unreachable: 'Unreachable', failed: 'Failed',
        cancelled: 'Cancelled', 'timed-out': 'Timed out', changed: 'Connection changed',
        unchecked: 'Not checked', loading: 'Loading', unavailable: 'Status unavailable',
      };
      const tooltips: Record<string, string> = {
        successful: 'Up & Running',
        waiting: 'Checking…',
        unreachable: 'Unreachable',
        failed: 'Check failed',
        'timed-out': 'Timed out',
        cancelled: 'Cancelled',
        changed: 'Needs recheck',
        unchecked: 'Not checked',
        loading: 'Loading…',
        unavailable: 'Status unavailable',
      };
      const color = outcome === 'successful' ? 'bg-emerald-500 ring-emerald-500/10' :
        ['unreachable', 'failed', 'timed-out'].includes(outcome) ? 'bg-red-500 ring-red-500/10' :
        outcome === 'waiting' ? 'bg-blue-500 ring-blue-500/10' : 'bg-slate-400 ring-slate-400/10';
      const detail = error || (changed ? 'SSH connection settings changed since this result. Run Ping again.' :
        result ? result.diagnostics || (result.outcome === 'waiting' ? 'Waiting for Ansible to report a result.' : 'No additional diagnostics reported.') : 'No Ping result for this host in the latest run.');
      return [host.id, { outcome, label: labels[outcome], tooltip: tooltips[outcome], color, detail }];
    }));
  });

  async refreshPing() {
    if (!this.service.desktop || this.destroyRef.destroyed) return;
    clearTimeout(this.pingTimer);
    const revision = ++this.pingRevision;
    try {
      const run = await this.automation.latest();
      if (this.destroyRef.destroyed || revision !== this.pingRevision) return;
      this.pingRun.set(run);
      this.selection.rememberPing(run);
      this.pingLoaded.set(true);
      this.pingError.set('');
    } catch (error) {
      if (this.destroyRef.destroyed || revision !== this.pingRevision) return;
      this.pingError.set(error instanceof Error ? error.message : String(error));
    }
    if (this.pingRun()?.active) this.pingTimer = setTimeout(() => void this.refreshPing(), 1000);
  }
  readonly selection = inject(InventorySelection);
  readonly runner = inject(AutomationRunner);
  async quickPing(host: Host) {
    if (this.busy()) return;
    await this.runner.runPing(host.id);
  }
  private readonly reboots = inject(RebootsService);
  readonly rowReboot = signal<RebootRun | null>(null);
  readonly rebootHost = signal<Host | null>(null);
  readonly rebootPending = signal(false);
  readonly rebootError = signal('');
  readonly rebootFeedback = computed(() => {
    const run = this.rowReboot();
    const result = run?.results.find(result => result.host.id === this.rebootHost()?.id);
    if (this.rebootError()) return { label: 'Status unavailable', busy: false, attention: true, detail: this.rebootError() };
    const state = result?.state;
    if (state === 'successful') return { label: result?.rebootRequired ? 'Reboot verified · reboot still required' : 'Reboot verified', busy: false, attention: !!result?.rebootRequired, detail: '' };
    if (state === 'failed' || state === 'unknown' || state === 'skipped') return {
      label: state === 'unknown' ? 'Reboot unconfirmed' : state === 'skipped' ? 'Reboot not started' : 'Reboot needs attention',
      busy: false, attention: true, detail: result?.message ?? '',
    };
    return { label: 'Rebooting',
      busy: this.rebootPending() || !!run?.active, attention: false, detail: '' };
  });
  private rebootTimer?: ReturnType<typeof setTimeout>;
  async quickReboot(host: Host) {
    if (!this.service.desktop || this.busy() || this.rebootPending() || this.rowReboot()?.active) return;
    clearTimeout(this.rebootTimer);
    this.rebootHost.set(host); this.rowReboot.set(null);
    await this.rebootOperation(async () => {
      let run = await this.reboots.preview({ hostIds: [host.id], groupIds: [] });
      const reviewId = run.id;
      while (run.active && run.phase === 'preview' && !this.destroyRef.destroyed) {
        this.rowReboot.set(run);
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (this.destroyRef.destroyed) return run;
        const latest = await this.reboots.latest();
        if (!latest || latest.id !== reviewId) throw new Error('Reboot review changed. No reboot submitted.');
        run = latest;
      }
      if (this.destroyRef.destroyed) return run;
      this.rowReboot.set(run);
      if (run.phase !== 'review' || run.active || run.results.length !== 1
          || run.results[0].host.id !== host.id || run.results[0].state !== 'ready') return run;
      // The row click authorizes this one fresh review only. Polling never retries apply.
      return this.reboots.apply(reviewId);
    });
  }
  async refreshReboot() {
    const run = this.rowReboot();
    if (!run || this.rebootPending()) return;
    await this.rebootOperation(() => this.reboots.refresh(run.id));
  }
  async pollReboot() {
    const expected = this.rowReboot()?.id;
    if (!expected || this.destroyRef.destroyed) return;
    await this.rebootOperation(async () => {
      const run = await this.reboots.latest();
      if (!run || run.id !== expected) throw new Error('Reboot review changed. Review this host again.');
      return run;
    });
  }
  private async rebootOperation(operation: () => Promise<RebootRun>) {
    clearTimeout(this.rebootTimer);
    this.rebootPending.set(true); this.rebootError.set('');
    try {
      const run = await operation();
      if (!this.destroyRef.destroyed) {
        const previous = this.rowReboot();
        this.rowReboot.set(run);
        if (run.results[0]?.state === 'successful' && previous?.results[0]?.state !== 'successful') {
          const host = this.hosts().find(host => host.id === run.results[0].host.id);
          if (host) this.queueSystemInfo([host]);
        }
      }
    } catch (error) { this.rebootError.set(String(error)); }
    finally { this.rebootPending.set(false); }
    if (!this.destroyRef.destroyed && this.rowReboot()?.active && !this.rebootError()) {
      this.rebootTimer = setTimeout(() => void this.pollReboot(), 1500);
    }
  }
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly groups = this.selection.groups;
  readonly groupId = signal('');
  readonly group = computed(() => this.groups().find(g => g.id === this.groupId()));
  readonly overlapId = signal('');
  readonly memberships = computed(() => {
    const memberships = new Map<string, HostGroup[]>();
    for (const group of this.groups()) {
      for (const id of group.memberIds) memberships.set(id, [...(memberships.get(id) ?? []), group]);
    }
    return memberships;
  });
  readonly overlaps = computed(() => {
    const members = new Set(this.group()?.memberIds ?? []);
    return this.groups().filter(group => group.id !== this.groupId()).map(group => ({
      ...group, count: group.memberIds.filter(id => members.has(id)).length,
    })).filter(group => group.count > 0);
  });
  readonly overlap = computed(() => this.overlaps().find(group => group.id === this.overlapId()));
  chooseGroup(id: string) { this.groupId.set(id); this.overlapId.set(''); }
  groupColor(id: string) { return this.selection.groupColors().get(id); }
  readonly groupEditing = signal(false);
  readonly groupEditId = signal<string | null>(null);
  readonly groupName = signal('');
  readonly selectedHostIds = this.selection.hostIds;
  readonly groupMembers = signal<string[]>([]);
  readonly rowIds = computed(() => this.groupEditing() ? this.groupMembers() : this.selectedHostIds());
  readonly selectedIds = computed(() => new Set(this.rowIds()));
  readonly allVisibleSelected = computed(() => this.filtered().length > 0 && this.filtered().every(host => this.selectedIds().has(host.id)));
  readonly someVisibleSelected = computed(() => this.filtered().some(host => this.selectedIds().has(host.id)));
  readonly hiddenSelectionCount = computed(() => {
    const visible = new Set(this.filtered().map(host => host.id));
    return this.rowIds().filter(id => !visible.has(id)).length;
  });
  selectVisible(checked: boolean) {
    if (this.busy()) return;
    for (const host of this.filtered()) this.toggleHostSelection(host.id, checked);
  }
  clearRows() { if (this.groupEditing()) this.groupMembers.set([]); else this.selection.clear(); }
  editGroup(group?: HostGroup) {
    this.groupEditId.set(group?.id ?? null);
    this.groupName.set(group?.name ?? '');
    this.groupMembers.set([...(group?.memberIds ?? this.selectedHostIds())]);
    if (group) {
      this.chooseGroup('');
      this.search.set('');
    }
    this.editing.set(false);
    this.groupEditing.set(true);
    afterNextRender(() => {
      const input = this.element.nativeElement.querySelector<HTMLInputElement>('#group-name');
      input?.focus(); input?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    }, { injector: this.injector });
  }
  toggleHostSelection(id: string, checked: boolean) {
    if (this.busy()) return;
    if (this.groupEditing()) this.groupMembers.update(ids => checked ? [...new Set([...ids, id])] : ids.filter(member => member !== id));
    else this.selection.select([id], checked);
  }
  async saveGroup() {
    if (!this.groupName().trim()) return;
    await this.perform(async () => {
      const group = await this.automation.save(this.groupEditId(), this.groupName().trim(), this.groupMembers());
      this.groups.update(groups => [...groups.filter(g => g.id !== group.id), group]);
      this.chooseGroup(group.id);
      this.groupEditing.set(false);
      this.status.set('Group saved.');
      await this.router.navigateByUrl('/groups');
    });
  }
  readonly systemInfo = inject(HostsService).systemInfo;
  readonly hostnameEdits = signal<Record<string, { value: string; editing: boolean; pending: boolean; message: string; error: string; logs: string }>>({});

  editHostname(host: Host) {
    if (this.hostnameEdits()[host.id]?.pending) return;
    this.hostnameEdits.update(edits => ({ ...edits, [host.id]: {
      value: this.systemInfo()[host.id]?.hostname ?? '', editing: true, pending: false, message: '', error: '', logs: '',
    } }));
    afterNextRender(() => {
      const input = this.element.nativeElement.querySelector<HTMLInputElement>(`[id="hostname-${host.id}"]`);
      input?.focus(); input?.select();
    }, { injector: this.injector });
  }

  hostnameValue(id: string, value: string) {
    this.hostnameEdits.update(edits => ({ ...edits, [id]: { ...edits[id], value } }));
  }

  cancelHostname(id: string) {
    if (this.hostnameEdits()[id]?.pending) return;
    this.hostnameEdits.update(edits => ({ ...edits, [id]: { ...edits[id], editing: false, error: '' } }));
  }

  async saveHostname(host: Host) {
    const edit = this.hostnameEdits()[host.id];
    if (!edit?.editing || edit.pending) return;
    const hostname = edit.value.trim();
    const update = (patch: Partial<typeof edit>) => this.hostnameEdits.update(edits => ({ ...edits, [host.id]: { ...edits[host.id], ...patch } }));
    if (!hostname || hostname.length > 64 || !hostname.split('.').every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
      update({ error: 'Use up to 64 lowercase letters, digits, hyphens or dots. Each label must start and end with a letter or digit.' });
      return;
    }
    if (hostname === this.systemInfo()[host.id]?.hostname) { this.cancelHostname(host.id); return; }
    update({ pending: true, error: '', message: 'Changing hostname through Ansible…' });
    try {
      const review = await this.service.review(host.id, { kind: 'setHostname', hostname });
      if (this.destroyRef.destroyed) return;
      if (review.host.id !== host.id || JSON.stringify(review.host.settings) !== JSON.stringify(host.settings)) throw new Error('Host settings changed. Open the editor again.');
      let job = await this.service.start(review.id, this.terminal());
      while (!this.destroyRef.destroyed) {
        if (job.hostId !== host.id || job.id !== review.id) throw new Error('Hostname operation does not match this host. Refresh to check its hostname.');
        update({ logs: job.logs ?? '' });
        if (job.state !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (this.destroyRef.destroyed) return;
        job = await this.service.operation(host.id, review.id);
      }
      if (this.destroyRef.destroyed) return;
      if (job.state !== 'succeeded') throw new Error(job.message);
      const system = job.overview?.sections.find(section => section.id === 'system' && section.status === 'ok' && !section.truncated);
      const detected = system?.output.split('\n').find(line => line.startsWith('Hostname:'))?.slice('Hostname:'.length).trim();
      if (detected !== hostname) throw new Error('Hostname change could not be verified. Refresh before retrying.');
      const current = this.hosts().find(item => item.id === host.id);
      if (!current || JSON.stringify(current.settings) !== JSON.stringify(host.settings)) return;
      this.systemInfo.update(info => info[host.id] ? { ...info, [host.id]: { ...info[host.id], hostname: detected, pending: false } } : info);
      update({ editing: false, message: `Hostname changed to ${detected}.` });
    } catch (error) {
      if (!this.destroyRef.destroyed) update({ error: String(error), message: '' });
    } finally {
      if (!this.destroyRef.destroyed) update({ pending: false });
    }
  }
  private systemTimer?: ReturnType<typeof setInterval>;
  readonly sort = signal('name');
  readonly layout = signal<'cards' | 'list'>('list');
  readonly expandedInfo = signal<ReadonlySet<string>>(new Set());

  toggleInfo(id: string) {
    this.expandedInfo.update(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  readonly shortcuts = [
    { tab: 'system', label: 'Overview', path: 'M4 4h16v12H4z M8 20h8 M12 16v4' },
    { tab: 'services', label: 'Services', path: 'M4 5h16v5H4z M4 14h16v5H4z M7 7.5h.01 M7 16.5h.01' },
    { tab: 'processes', label: 'Processes', path: 'M3 12h4l3-8 4 16 3-8h4' },
    { tab: 'accounts', label: 'Accounts', path: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M17 4a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87' },
  ];
  readonly service = inject(HostsService);
  private readonly fb = inject(FormBuilder);
  readonly hosts = this.selection.hosts;
  readonly identities = signal<IdentityOptions>({ agentIdentities: [], keyFiles: [], agentError: null, keyError: null });
  readonly terminals = signal<Terminal[]>([]);
  readonly terminal = signal('');
  readonly search = signal('');
  readonly busy = signal(false);
  readonly loaded = signal(false);
  readonly error = signal('');
  readonly status = signal('');
  readonly editing = signal(false);
  readonly editId = signal<string | null>(null);
  readonly deleting = signal<Host | null>(null);
  readonly filtered = computed(() => {
    const search = this.search().trim().toLowerCase();
    return this.hosts().filter(h => {
      return (!this.group() || this.group()!.memberIds.includes(h.id))
        && (!this.overlap() || this.overlap()!.memberIds.includes(h.id));
    }).filter(({ settings: h }) => `${h.name} ${h.address} ${h.username}`.toLowerCase().includes(search)).sort((a, b) => {
      const key = this.sort() as 'name' | 'address' | 'username';
      return a.settings[key].localeCompare(b.settings[key], undefined, { numeric: true, sensitivity: 'base' });
    });
  });
  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    address: ['', Validators.required],
    username: ['', [Validators.required, Validators.pattern(/^[a-zA-Z0-9_.][a-zA-Z0-9_.-]{0,63}$/)]],
    port: [22, [Validators.required, Validators.min(1), Validators.max(65535), Validators.pattern(/^\d+$/)]],
    kind: this.fb.nonNullable.control<'agent' | 'keyFile'>('agent'),
    identity: ['', Validators.required],
  });

  constructor() {
    const seen = new Map<string, string>();
    effect(() => {
      const results = this.selection.pingResults();
      untracked(() => {
        for (const [id, result] of results) {
          const signature = JSON.stringify(result);
          if (seen.get(id) === signature) continue;
          seen.set(id, signature);
          const host = this.hosts().find(host => host.id === id);
          if (host && result.outcome === 'successful' && !this.systemInfo()[id]?.pending) this.queueSystemInfo([host]);
        }
      });
    });
    this.destroyRef.onDestroy(() => { this.systemQueue = []; clearInterval(this.systemTimer); clearTimeout(this.rebootTimer); clearTimeout(this.pingTimer); ++this.pingRevision; });
  }

  copyInfo(host: Host, label: string, value: string | number) {
    const copied = this.clipboard.copy(String(value));
    this.snackBar.open(copied ? `${label} copied for ${host.settings.name}.` : 'Could not copy. Select the value and copy it manually.', 'Dismiss', { duration: 3000 });
  }

  private queueSystemInfo(hosts: Host[]) {
    hosts = hosts.filter(host => !this.activeSystemRequests.has(JSON.stringify([host.id, host.settings])));
    this.systemInfo.update(current => ({
      ...current,
      ...Object.fromEntries(hosts.map(host => {
        const settings = JSON.stringify(host.settings);
        const previous = current[host.id]?.settings === settings ? current[host.id] : undefined;
        return [host.id, { name: previous?.name ?? '', hostname: previous?.hostname ?? '', kernel: previous?.kernel ?? '',
          updatedAt: previous?.updatedAt ?? 0, settings, pending: true, error: '' }];
      })),
    }));
    const ids = new Set(hosts.map(host => host.id));
    this.systemQueue = [...this.systemQueue.filter(host => !ids.has(host.id)), ...hosts];
    this.inspectNext();
  }

  private inspectNext() {
    if (this.destroyRef.destroyed) return;
    while (this.activeInspections < 4 && this.systemQueue.length) {
      const host = this.systemQueue.shift()!;
      if (!this.hosts().includes(host)) continue;
      ++this.activeInspections;
      this.activeSystemRequests.add(JSON.stringify([host.id, host.settings]));
      void this.loadSystemInfo(host);
    }
  }

  private async loadSystemInfo(host: Host) {
    const pending = this.systemInfo()[host.id];
    const current = () => !this.destroyRef.destroyed && this.hosts().some(saved => saved.id === host.id && JSON.stringify(saved.settings) === JSON.stringify(host.settings)) && this.systemInfo()[host.id] === pending;
    try {
      const overview = await this.service.system(host);
      if (!current()) return;
      if (overview.target && JSON.stringify(overview.target.settings) !== JSON.stringify(host.settings)) {
        throw new Error('Host settings changed. Refresh the inventory to retry.');
      }
      const system = overview.sections.find(section => section.id === 'system' && section.status === 'ok');
      if (!system || system.truncated) throw new Error('System information is unavailable. Open Overview for details.');
      const value = (prefix: string) => system.output.split('\n').find(line => line.startsWith(prefix))?.slice(prefix.length).trim().replace(/^["']|["']$/g, '') ?? '';
      const name = value('PRETTY_NAME=') || [value('NAME='), value('VERSION_ID=')].filter(Boolean).join(' ');
      if (!name) throw new Error('The host did not report an OS name. Open Overview for details.');
      this.systemInfo.update(info => ({ ...info, [host.id]: { ...pending, name, hostname: value('Hostname:'), kernel: value('Kernel:'), updatedAt: Date.now(), pending: false, error: '' } }));
    } catch (error) {
      if (current()) this.systemInfo.update(info => ({ ...info, [host.id]: {
        ...pending, pending: false,
        error: error instanceof Error ? error.message : typeof error === 'string' ? error : 'Could not inspect this host. Open Overview for details.',
      } }));
    } finally {
      --this.activeInspections;
      this.activeSystemRequests.delete(JSON.stringify([host.id, host.settings]));
      this.inspectNext();
    }
  }

  async ngOnInit() {
    if (!this.service.desktop) return;
    await this.refresh();
    if (this.destroyRef.destroyed) return;
    this.systemTimer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      this.queueSystemInfo(this.hosts().filter(host => {
        const info = this.systemInfo()[host.id];
        return !info?.pending && (!info?.name || !!info.error || Date.now() - info.updatedAt >= 60000);
      }));
    }, 15000);
    const params = this.route.snapshot.queryParamMap;
    this.groupId.set(params.get('group') ?? '');
    this.overlapId.set(params.get('overlap') ?? '');
    const edit = params.get('editGroup');
    if (edit === 'new') this.editGroup();
    else if (edit) {
      const group = this.groups().find(group => group.id === edit);
      if (group) this.editGroup(group); else this.error.set('This group no longer exists. Return to Groups and refresh.');
    }
  }

  async refresh() {
    void this.refreshPing();
    await this.perform(async () => {
      const hostRequest = this.service.list().then(hosts => {
        if (this.destroyRef.destroyed) return;
        this.hosts.set(hosts);
        this.loaded.set(true);
        this.systemQueue = [];
        this.systemInfo.update(info => Object.fromEntries(hosts.flatMap(host => {
          const cached = info[host.id];
          return cached?.settings === JSON.stringify(host.settings) ? [[host.id, cached]] : [];
        })));
        this.queueSystemInfo(hosts);
      });
      const [, identities, terminals, groups] = await Promise.all([hostRequest, this.service.identities(), this.service.terminals(), this.automation.groups()]);
      if (this.destroyRef.destroyed) return;
      this.groups.set(groups);
      if (!groups.some(g => g.id === this.groupId())) this.groupId.set('');
      this.identities.set(identities);
      this.terminals.set(terminals);
      if (!terminals.some(t => t.id === this.terminal())) this.terminal.set(terminals[0]?.id ?? '');
    });
  }

  edit(host?: Host) {
    this.error.set('');
    this.status.set('');
    this.editId.set(host?.id ?? null);
    const auth = host?.settings.authentication;
    this.form.reset({
      name: host?.settings.name ?? '', address: host?.settings.address ?? '',
      username: host?.settings.username ?? '', port: host?.settings.port ?? 22,
      kind: auth?.kind ?? 'agent', identity: auth?.kind === 'agent' ? auth.fingerprint : auth?.filename ?? '',
    });
    this.editing.set(true);
    this.groupEditing.set(false);
    this.deleting.set(null);
    afterNextRender(() => {
      const input = this.element.nativeElement.querySelector<HTMLInputElement>('input[formControlName="name"]');
      input?.focus(); input?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    }, { injector: this.injector });
  }

  identityUnavailable(): boolean {
    const { kind, identity } = this.form.getRawValue();
    return !!identity && (kind === 'agent'
      ? !this.identities().agentIdentities.some(i => i.fingerprint === identity)
      : !this.identities().keyFiles.includes(identity));
  }

  async save() {
    if (this.form.invalid) { this.form.markAllAsTouched(); return; }
    const { name, address, username, port, kind, identity } = this.form.getRawValue();
    await this.perform(async () => {
      const host = await this.service.save(this.editId(), {
        name: name.trim(), address: address.trim(), username: username.trim(), port,
        authentication: kind === 'agent' ? { kind, fingerprint: identity } : { kind, filename: identity },
      });
      this.hosts.update(hosts => this.editId() ? hosts.map(h => h.id === host.id ? host : h) : [...hosts, host]);
      this.editing.set(false);
      this.status.set('Host saved.');
      this.queueSystemInfo([host]);
    });
  }

  async remove(host: Host) {
    await this.perform(async () => {
      await this.service.delete(host.id);
      this.hosts.update(hosts => hosts.filter(h => h.id !== host.id));
      this.groups.update(groups => groups.map(g => ({ ...g, memberIds: g.memberIds.filter(id => id !== host.id) })));
      this.selectedHostIds.update(ids => ids.filter(id => id !== host.id));
      this.systemQueue = this.systemQueue.filter(item => item.id !== host.id);
      this.systemInfo.update(info => {
        const remaining = { ...info };
        delete remaining[host.id];
        return remaining;
      });
      this.deleting.set(null);
      if (this.editId() === host.id) this.editing.set(false);
      this.status.set('Host removed from inventory.');
    });
  }

  async connect(host: Host) {
    await this.perform(async () => {
      await this.service.connect(host.id, this.terminal());
      this.status.set(`Terminal launched for ${host.settings.name}. Check the terminal for SSH authentication and connection status.`);
    });
  }

  private async perform(action: () => Promise<void>) {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.status.set('');
    try { await action(); }
    catch (error) { this.error.set(error instanceof Error ? error.message : typeof error === 'string' ? error : 'The operation failed. Please retry.'); }
    finally { this.busy.set(false); }
  }
}
