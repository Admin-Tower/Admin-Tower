import { Component, inject, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { InventorySelection } from '../hosts/inventory-selection.service';
import { HostsService } from '../hosts/hosts.service';
import { AutomationService } from './automation.service';
import { AutomationRunner } from './automation-runner.service';
import { AUTOMATION_TASKS } from './tasks';

@Component({ selector: 'tower-automation', imports: [RouterLink], templateUrl: './automation.html' })
export class Automation implements OnInit {
  readonly selection = inject(InventorySelection);
  readonly runner = inject(AutomationRunner);
  private readonly inventory = inject(HostsService);
  private readonly service = inject(AutomationService);
  readonly tasks = AUTOMATION_TASKS;
  async ngOnInit() {
    if (!this.inventory.desktop) return;
    try {
      const [hosts, groups] = await Promise.all([this.inventory.list(), this.service.groups()]);
      this.selection.hosts.set(hosts); this.selection.groups.set(groups);
    } catch (error) { this.runner.error.set(String(error)); }
  }
}
