import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { InventorySelection } from '../hosts/inventory-selection.service';
import { HostsService } from '../hosts/hosts.service';
import { AutomationService } from './automation.service';

@Injectable({ providedIn: 'root' })
export class AutomationRunner {
  readonly selection = inject(InventorySelection);
  readonly desktop = inject(HostsService).desktop;
  private readonly service = inject(AutomationService);
  private readonly router = inject(Router);
  readonly pending = signal(false);
  readonly error = signal('');
  readonly canRun = computed(() => this.desktop && this.selection.hasSelection() && !this.pending());
  async runPing() {
    if (!this.canRun()) return null;
    const targets = this.selection.snapshot();
    this.pending.set(true);
    this.error.set('');
    try {
      await this.service.availability();
      const run = await this.service.start(targets);
      // Never consume selections when starting fails, or clear newly added targets.
      this.selection.consume(targets);
      await this.router.navigateByUrl('/automation/ping');
      return run;
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
      return null;
    } finally { this.pending.set(false); }
  }
}
