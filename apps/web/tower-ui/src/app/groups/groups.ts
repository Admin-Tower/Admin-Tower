import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { AutomationService, HostGroup } from '../automation/automation.service';
import { AutomationRunner } from '../automation/automation-runner.service';
import { InventorySelection } from '../hosts/inventory-selection.service';
import { HostsService } from '../hosts/hosts.service';

@Component({ selector: 'tower-groups', imports: [RouterLink, MatButtonModule], templateUrl: './groups.html' })
export class Groups implements OnInit {
  readonly selection = inject(InventorySelection);
  readonly runner = inject(AutomationRunner);
  readonly inventory = inject(HostsService);
  private readonly service = inject(AutomationService);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly search = signal('');
  readonly deleting = signal<HostGroup | null>(null);
  readonly cards = computed(() => {
    const counts = new Map<string, number>();
    for (const group of this.selection.groups()) for (const id of group.memberIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    return this.selection.groups().filter(group => group.name.toLowerCase().includes(this.search().trim().toLowerCase())).map(group => ({
      ...group, shared: group.memberIds.filter(id => (counts.get(id) ?? 0) > 1).length,
      overlaps: this.selection.groups().filter(other => other.id !== group.id).map(other => ({
        ...other, count: other.memberIds.filter(id => group.memberIds.includes(id)).length,
      })).filter(other => other.count > 0),
    }));
  });
  ngOnInit() { if (this.inventory.desktop) void this.refresh(); }
  async refresh() {
    this.busy.set(true); this.error.set('');
    try {
      const [hosts, groups] = await Promise.all([this.inventory.list(), this.service.groups()]);
      this.selection.hosts.set(hosts); this.selection.groups.set(groups);
    } catch (error) { this.error.set(String(error)); }
    finally { this.busy.set(false); }
  }
  async remove() {
    const group = this.deleting();
    if (!group || this.busy()) return;
    this.busy.set(true); this.error.set('');
    try {
      await this.service.delete(group.id);
      this.selection.groups.update(groups => groups.filter(item => item.id !== group.id));
      this.selection.selectGroup(group.id, false);
      this.deleting.set(null);
    } catch (error) { this.error.set(String(error)); }
    finally { this.busy.set(false); }
  }
}
