import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { InventorySelection } from '../hosts/inventory-selection.service';
import { HostsService } from '../hosts/hosts.service';
import { AutomationService, PingRun } from './automation.service';

@Injectable({ providedIn: 'root' })
export class AutomationRunner {
  readonly selection = inject(InventorySelection);
  readonly desktop = inject(HostsService).desktop;
  private readonly service = inject(AutomationService);
  private readonly router = inject(Router);
  readonly pending = signal(false);
  readonly error = signal('');
  readonly canRun = computed(() => this.desktop && this.selection.hasSelection() && !this.pending());
  readonly quickPending = signal<ReadonlySet<string>>(new Set());
  async runQuick(hostId: string): Promise<PingRun | null> {
    if (!this.desktop || this.quickPending().has(hostId)) return null;
    this.quickPending.update(ids => new Set([...ids, hostId]));
    try {
      const run = await this.service.startQuick(hostId);
      this.selection.rememberPing(run, true);
      if (run.active) setTimeout(() => void this.pollQuick(hostId), 1000);
      else this.finishQuick(hostId);
      return run;
    } catch (error) { this.error.set(String(error)); this.finishQuick(hostId); return null; }
  }
  private finishQuick(hostId: string) {
    this.quickPending.update(ids => { const next = new Set(ids); next.delete(hostId); return next; });
  }
  private async pollQuick(hostId: string) {
    try {
      const run = await this.service.latestQuick(hostId);
      this.selection.rememberPing(run, true);
      if (run?.active) { setTimeout(() => void this.pollQuick(hostId), 1000); return; }
      this.finishQuick(hostId);
    } catch (error) {
      this.error.set(String(error));
      setTimeout(() => void this.pollQuick(hostId), 2000);
    }
  }
  async runPing(hostId?: string) {
    if (hostId) return this.runQuick(hostId);
    if (!this.desktop || this.pending() || (!hostId && !this.canRun())) return null;
    const targets = hostId ? { hostIds: [hostId], groupIds: [] } : this.selection.snapshot();
    this.pending.set(true);
    this.error.set('');
    try {
      await this.service.availability();
      const run = await this.service.start(targets);
      // Never consume selections when starting fails, or clear newly added targets.
      if (!hostId) this.selection.consume(targets);
      for (const result of run.results) this.selection.quickOverrides.delete(result.host.id);
      this.selection.rememberPing(run);
      if (!hostId) await this.router.navigateByUrl('/automation/ping');
      return run;
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
      return null;
    } finally { this.pending.set(false); }
  }
}
