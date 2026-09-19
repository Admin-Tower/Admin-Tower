import { Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { HostAction, HostSection } from '../../hosts/hosts.service';
import { compareCells, inspectionData } from '../inspection-data';

@Component({
  selector: 'tower-inspection-table',
  imports: [FormsModule, MatButtonModule],
  templateUrl: './inspection-table.html', styleUrl: './inspection-table.scss',
})
export class InspectionTable {
  readonly section = input.required<HostSection>();
  readonly title = input.required<string>();
  readonly actionLabel = input('');
  readonly actionsDisabled = input(false);
  readonly serviceAction = output<Extract<HostAction, { kind: 'service' }>>();
  readonly quickServices = input(false);
  serviceActions(row: string[]): { label: string; verb: Extract<HostAction, { kind: 'service' }>['verb'] }[] {
    if (this.section().id === 'serviceFiles') return row[1] === 'enabled' ? [{ label: 'Disable at boot', verb: 'disable' }] : row[1] === 'disabled' ? [{ label: 'Enable at boot', verb: 'enable' }] : [];
    return row[2] === 'active' ? [{ label: 'Restart', verb: 'restart' }, { label: 'Stop', verb: 'stop' }] : ['inactive', 'failed'].includes(row[2]) ? [{ label: 'Start', verb: 'start' }] : [];
  }
  readonly selected = output<string[]>();
  readonly query = signal('');
  readonly stateFilter = signal('');
  readonly page = signal(0);
  readonly pageSize = signal(25);
  readonly ordering = signal<{ column: number; descending: boolean } | null>(null);
  readonly data = computed(() => inspectionData(this.section()));
  readonly sort = computed(() => this.ordering() ?? this.data().sort ?? { column: -1, descending: false });
  readonly stateColumn = computed(() => {
    const preferred = this.data().columns.findIndex(c => ['Active', 'State', 'Boot state'].includes(c.label));
    return preferred >= 0 ? preferred : this.data().columns.findIndex(c => c.kind === 'state');
  });
  readonly states = computed(() => [...new Set(this.data().rows.map(r => r[this.stateColumn()]).filter(Boolean))].sort());
  readonly filtered = computed(() => {
    const terms = this.query().trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const rows = this.data().rows.filter(row => (!this.stateFilter() || row[this.stateColumn()] === this.stateFilter()) && terms.every(term => row.some(cell => cell.toLocaleLowerCase().includes(term))));
    const sort = this.sort();
    if (sort.column < 0) return rows;
    const column = this.data().columns[sort.column];
    return rows.sort((a, b) => compareCells(a[sort.column] ?? '', b[sort.column] ?? '', column?.kind) * (sort.descending ? -1 : 1));
  });
  readonly pages = computed(() => Math.max(1, Math.ceil(this.filtered().length / this.pageSize())));
  readonly currentPage = computed(() => Math.min(this.page(), this.pages() - 1));
  readonly start = computed(() => this.currentPage() * this.pageSize());
  readonly visible = computed(() => this.filtered().slice(this.start(), this.start() + this.pageSize()));
  readonly end = computed(() => this.start() + this.visible().length);
  readonly failure = computed(() => ({ denied: 'This account cannot read this information. Inspect with sudo for privileged visibility.', unavailable: 'This tool is not installed on the host.', timeout: 'The command exceeded its time limit.', error: 'The host could not complete this inspection.' }[this.section().status] ?? ''));

  sortBy(column: number) {
    this.ordering.set({ column, descending: this.sort().column === column ? !this.sort().descending : false });
    this.page.set(0);
  }
  search(value: string) { this.query.set(value); this.page.set(0); }
  filterState(value: string) { this.stateFilter.set(value); this.page.set(0); }
  resize(value: number) { this.pageSize.set(Number(value)); this.page.set(0); }
  clear() { this.query.set(''); this.stateFilter.set(''); this.page.set(0); }
  tone(value: string) {
    if (/^(active|running|enabled|UP|LISTEN)$/i.test(value)) return 'positive';
    if (/^(failed|error|not-found|DOWN)$/i.test(value)) return 'negative';
    return 'neutral';
  }
}
