import { AutomationRunner } from '../automation-runner.service';
import { InventorySelection } from '../../hosts/inventory-selection.service';
import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { HostsService } from '../../hosts/hosts.service';
import { AutomationService, PingRun } from '../automation.service';
import { PING_TASK } from '../tasks';

@Component({
  selector: 'tower-ping',
  imports: [RouterLink, MatButtonModule, MatProgressBarModule],
  templateUrl: './ping.html',
})
export class Ping implements OnInit {
  private readonly inventory = inject(HostsService);
  readonly desktop = this.inventory.desktop;
  private readonly service = inject(AutomationService);
  private readonly destroyRef = inject(DestroyRef);
  readonly task = PING_TASK;
  readonly runner = inject(AutomationRunner);
  readonly selection = inject(InventorySelection);
  readonly targetHosts = this.selection.selectedHosts;
  readonly loading = signal(true);
  readonly targetsError = signal('');
  readonly error = this.runner.error;
  readonly pollError = signal('');
  readonly run = signal<PingRun | null>(null);
  readonly runLoaded = signal(false);
  readonly pending = signal<'start' | 'cancel' | null>(null);
  readonly completed = computed(() => this.run()?.results.filter(r => r.outcome !== 'waiting').length ?? 0);
  readonly succeeded = computed(() => this.run()?.results.filter(r => r.outcome === 'successful').length ?? 0);
  readonly needsAttention = computed(() => this.completed() - this.succeeded());
  readonly canRun = computed(() => this.targetHosts().length > 0 && !this.loading() && !this.targetsError() && !this.selection.missingCount() && this.runLoaded() && !this.pollError() && !this.pending() && !this.runner.pending() && !this.run()?.active);
  readonly labels: Record<PingRun['results'][number]['outcome'], string> = {
    waiting: 'Waiting', successful: 'Successful', unreachable: 'Unreachable', failed: 'Failed', cancelled: 'Cancelled', 'timed-out': 'Timed out',
  };
  private timer?: ReturnType<typeof setTimeout>;
  private pollRevision = 0;

  constructor() {
    this.destroyRef.onDestroy(() => { ++this.pollRevision; clearTimeout(this.timer); });
  }
  ngOnInit() {
    if (this.desktop) { void this.refreshTargets(); void this.poll(); }
  }
  async refreshTargets() {
    if (!this.desktop) return;
    this.loading.set(true);
    this.targetsError.set('');
    try {
      const [hosts, groups] = await Promise.all([this.inventory.list(), this.service.groups()]);
      if (this.destroyRef.destroyed) return;
      this.selection.hosts.set(hosts);
      this.selection.groups.set(groups);
    } catch (error) { this.targetsError.set(this.message(error)); }
    finally { this.loading.set(false); }
  }
  async poll() {
    if (!this.desktop || this.destroyRef.destroyed) return;
    clearTimeout(this.timer);
    const revision = ++this.pollRevision;
    try {
      const run = await this.service.latest();
      if (this.destroyRef.destroyed || revision !== this.pollRevision) return;
      this.run.set(run);
      this.runLoaded.set(true);
      this.pollError.set('');
      if (run?.active) this.timer = setTimeout(() => void this.poll(), 1000);
    } catch (error) {
      if (this.destroyRef.destroyed || revision !== this.pollRevision) return;
      this.pollError.set(this.message(error));
      if (this.run()?.active) this.timer = setTimeout(() => void this.poll(), 1000);
    }
  }
  async start() {
    if (!this.desktop || !this.canRun()) return;
    this.pending.set('start');
    this.error.set('');
    ++this.pollRevision;
    clearTimeout(this.timer);
    try {
      const run = await this.runner.runPing();
      if (!run || this.destroyRef.destroyed) return;
      this.run.set(run);
      await this.poll();
    } catch (error) { this.error.set(this.message(error)); }
    finally { this.pending.set(null); }
  }
  async cancel() {
    const run = this.run();
    if (!this.desktop || !run?.active || this.pending()) return;
    this.pending.set('cancel');
    this.error.set('');
    try { await this.service.cancel(run.id); await this.poll(); }
    catch (error) { this.error.set(this.message(error)); }
    finally { this.pending.set(null); }
  }
  private message(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
