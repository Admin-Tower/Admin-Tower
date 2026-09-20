import { computed, Injectable, signal } from '@angular/core';
import { Host } from './hosts.service';
import { AutomationTargets, HostGroup } from '../automation/automation.service';

/** Explicit host and group choices survive navigation until successfully submitted. */
@Injectable({ providedIn: 'root' })
export class InventorySelection {
  readonly hostIds = signal<string[]>([]);
  readonly groupIds = signal<string[]>([]);
  readonly hosts = signal<Host[]>([]);
  readonly groups = signal<HostGroup[]>([]);
  readonly groupColors = computed(() => {
    const palette = ['#1d4ed8', '#7e22ce', '#0f766e', '#b45309', '#be185d', '#0369a1'];
    const colors = new Map<string, string>();
    for (const group of [...this.groups()].sort((a, b) => a.id.localeCompare(b.id))) {
      let hash = 0;
      for (const char of group.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      let index = hash % palette.length;
      if (colors.size < palette.length) {
        while ([...colors.values()].includes(palette[index])) index = (index + 1) % palette.length;
      }
      colors.set(group.id, palette[index]);
    }
    return colors;
  });
  readonly selectedGroups = computed(() => this.groups().filter(group => this.groupIds().includes(group.id)));
  readonly groupHostIds = computed(() => new Set(this.selectedGroups().flatMap(group => group.memberIds)));
  readonly targetIds = computed(() => new Set([...this.hostIds(), ...this.groupHostIds()]));
  readonly selectedHosts = computed(() => this.hosts().filter(host => this.targetIds().has(host.id)));
  readonly hasSelection = computed(() => this.hostIds().length + this.groupIds().length > 0);
  readonly summary = computed(() => [
    this.hostIds().length ? `${this.hostIds().length} host${this.hostIds().length === 1 ? '' : 's'}` : '',
    this.groupIds().length ? `${this.groupIds().length} group${this.groupIds().length === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' + '));
  readonly missingCount = computed(() => this.hostIds().filter(id => !this.hosts().some(host => host.id === id)).length
    + this.groupIds().filter(id => !this.groups().some(group => group.id === id)).length);
  select(ids: string[], checked: boolean) {
    const members = new Set(ids);
    this.hostIds.update(current => checked ? [...new Set([...current, ...ids])] : current.filter(id => !members.has(id)));
  }
  selectGroup(id: string, checked: boolean) {
    this.groupIds.update(ids => checked ? [...new Set([...ids, id])] : ids.filter(value => value !== id));
  }
  snapshot(): AutomationTargets { return { hostIds: [...this.hostIds()], groupIds: [...this.groupIds()] }; }
  consume(targets: AutomationTargets) {
    this.hostIds.update(ids => ids.filter(id => !targets.hostIds.includes(id)));
    this.groupIds.update(ids => ids.filter(id => !targets.groupIds.includes(id)));
  }
  clear() { this.hostIds.set([]); this.groupIds.set([]); }
}
