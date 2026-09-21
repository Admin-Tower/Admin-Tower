import { RunLog } from '../run-log/run-log';
import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { HostsService } from '../../hosts/hosts.service';
import { InventorySelection } from '../../hosts/inventory-selection.service';
import { AutomationService } from '../automation.service';
import { PackageRun, PackageUpdatesService } from './package-updates.service';

@Component({
  selector: 'tower-packages',
  imports: [RunLog, RouterLink, DatePipe, MatButtonModule, MatProgressBarModule],
  templateUrl: './packages.html',
})
export class Packages implements OnInit {
  private readonly router = inject(Router);
  private readonly hosts = inject(HostsService);
  private readonly automation = inject(AutomationService);
  private readonly service = inject(PackageUpdatesService);
  private readonly destroyRef = inject(DestroyRef);
  readonly desktop = this.hosts.desktop;
  readonly selection = inject(InventorySelection);
  readonly run = signal<PackageRun | null>(null);
  readonly loading = signal(true);
  readonly loaded = signal(false);
  readonly pending = signal(false);
  readonly error = signal('');
  readonly targetsError = signal('');
  readonly pollError = signal('');
  readonly unresolved = computed(() => this.run()?.results.some(r => ['launching', 'running', 'unknown'].includes(r.state)) ?? false);
  readonly packageCount = computed(() => this.run()?.results.reduce((count, r) => count + (r.plan?.packages.length ?? 0), 0) ?? 0);
  readonly deferredCount = computed(() => this.run()?.results.reduce((count, r) => count + (r.plan?.deferred.length ?? 0), 0) ?? 0);
  readonly emptyPreview = computed(() => {
    const run = this.run();
    return run?.phase === 'review' && !run.active && run.results.length > 0
      && run.results.every(r => r.state === 'ready' && r.plan?.packages.length === 0);
  });
  resultLabel(result: PackageRun['results'][number]) {
    if (result.state === 'ready' && result.plan?.packages.length === 0) {
      return result.plan.deferred.length ? 'Updates deferred' : 'Up to date';
    }
    return this.labels[result.state];
  }
  readonly canPreview = computed(() => this.desktop && this.loaded() && !this.loading() && !this.pending() && !this.pollError() && !this.targetsError()
    && !this.run()?.active && !this.unresolved() && this.selection.selectedHosts().length > 0 && !this.selection.missingCount());
  readonly canApply = computed(() => this.desktop && !this.pending() && !this.pollError() && this.run()?.phase === 'review'
    && !this.run()?.active && this.run()?.results.every(r => r.state === 'ready') && this.packageCount() > 0);
  readonly labels: Record<PackageRun['results'][number]['state'], string> = {
    waiting: 'Inspecting', ready: 'Ready for review', launching: 'Starting', running: 'Updating',
    unknown: 'Outcome unconfirmed', successful: 'Successful', failed: 'Needs attention', skipped: 'Not started',
  };
  private timer?: ReturnType<typeof setTimeout>;
  private revision = 0;
  constructor() {
    this.destroyRef.onDestroy(() => { ++this.revision; clearTimeout(this.timer); });
  }
  ngOnInit() { if (this.desktop) { void this.refreshTargets(); void this.poll(); } }
  reviewReboot(hostId: string) {
    if (this.run()?.active || this.unresolved() || this.pending()) return;
    this.selection.hostIds.set([hostId]);
    this.selection.groupIds.set([]);
    return this.router.navigateByUrl('/automation/reboot');
  }
  async refreshTargets() {
    this.loading.set(true); this.targetsError.set('');
    try {
      const [hosts, groups] = await Promise.all([this.hosts.list(), this.automation.groups()]);
      if (this.destroyRef.destroyed) return;
      this.selection.hosts.set(hosts); this.selection.groups.set(groups);
    } catch (error) { this.targetsError.set(String(error)); }
    finally { this.loading.set(false); }
  }
  async poll() {
    if (!this.desktop || this.destroyRef.destroyed || this.pending()) return;
    clearTimeout(this.timer);
    const revision = ++this.revision;
    try {
      const run = await this.service.latest();
      if (this.destroyRef.destroyed || revision !== this.revision) return;
      this.run.set(run); this.loaded.set(true); this.pollError.set('');
    } catch (error) {
      if (this.destroyRef.destroyed || revision !== this.revision) return;
      this.pollError.set(String(error));
    }
    if (this.run()?.active) this.timer = setTimeout(() => void this.poll(), 1500);
  }
  async preview() {
    if (!this.canPreview()) return;
    const targets = this.selection.snapshot();
    await this.perform(async () => {
      const run = await this.service.preview(targets);
      this.selection.consume(targets);
      return run;
    });
  }
  async apply() {
    const run = this.run();
    if (!run || !this.canApply()) return;
    await this.perform(() => this.service.apply(run.id));
  }
  async refresh() {
    const run = this.run();
    if (!run || !this.desktop || this.pending() || run.active) return;
    await this.perform(() => this.service.refresh(run.id));
  }
  async stop() {
    const run = this.run();
    if (!run || !this.desktop || this.pending() || !run.active) return;
    await this.perform(async () => { await this.service.stop(run.id); return { ...run, stopRequested: true }; });
  }
  private async perform(operation: () => Promise<PackageRun>) {
    this.pending.set(true); this.error.set('');
    ++this.revision; clearTimeout(this.timer);
    try {
      const run = await operation();
      if (!this.destroyRef.destroyed) this.run.set(run);
    } catch (error) { if (!this.destroyRef.destroyed) this.error.set(String(error)); }
    finally { this.pending.set(false); }
    if (!this.destroyRef.destroyed) await this.poll();
  }
}
