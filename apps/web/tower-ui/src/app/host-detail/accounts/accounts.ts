import { afterNextRender, Component, computed, ElementRef, inject, Injector, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { HostAction, HostSection } from '../../hosts/hosts.service';
import { inspectionData } from '../inspection-data';

interface AccountUser { name: string; uid: string; gid: string; description: string; home: string; shell: string }
interface AccountGroup { name: string; gid: string; members: string[] }

@Component({
  selector: 'tower-accounts', imports: [FormsModule, MatButtonModule],
  templateUrl: './accounts.html', styleUrl: './accounts.scss',
})
export class Accounts {
  readonly sections = input.required<HostSection[]>();
  readonly canManage = input(false);
  readonly review = output<HostAction>();
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  readonly datasets = computed(() => ['users', 'groups'].map(id => {
    const section = this.sections().find(s => s.id === id) ?? { id, status: 'not-collected', output: '', truncated: false };
    return { section, parsed: inspectionData(section) };
  }));
  readonly users = computed<AccountUser[]>(() => this.datasets()[0].parsed.rows.map(([name, uid, gid, description, home, shell]) => ({ name, uid, gid, description, home, shell })));
  readonly groups = computed<AccountGroup[]>(() => this.datasets()[1].parsed.rows.map(([name, gid, members]) => ({ name, gid, members: members.split(', ').filter(Boolean) })));
  readonly mode = signal<'users' | 'groups'>('users');
  readonly query = signal('');
  readonly filter = signal('');
  readonly sortColumn = signal(0);
  readonly descending = signal(false);
  readonly page = signal(0);
  readonly size = signal(25);
  readonly selected = signal<{ kind: 'users' | 'groups'; name: string } | null>(null);
  addName = '';
  readonly selectedUser = computed(() => this.selected()?.kind === 'users' ? this.users().find(u => u.name === this.selected()?.name) : undefined);
  readonly selectedGroup = computed(() => this.selected()?.kind === 'groups' ? this.groups().find(g => g.name === this.selected()?.name) : undefined);
  readonly current = computed(() => this.datasets()[this.mode() === 'users' ? 0 : 1]);
  readonly headers = computed(() => this.mode() === 'users' ? ['User', 'UID', 'Primary group', 'Shell', 'Home'] : ['Group', 'GID', 'Primary members', 'Supplementary members']);
  readonly rows = computed(() => {
    const terms = this.query().trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = this.mode() === 'users'
      ? this.users().filter(u => !this.filter() || (this.filter() === 'root' ? Number(u.uid) === 0 : /\/(?:nologin|false)$/.test(u.shell))).map(u => ({
        cells: [u.name, u.uid, this.primaryLabel(u), u.shell || 'Not reported', u.home || 'Not reported'],
        search: [u.name, u.uid, u.gid, u.description, u.home, u.shell, this.primaryLabel(u), ...this.supplementary(u).map(g => g.name)].join(' '),
      }))
      : this.groups().filter(g => !this.filter() || (!this.primaryMembers(g).length && !g.members.length)).map(g => ({
        cells: [g.name, g.gid, String(this.primaryMembers(g).length), String(g.members.length)],
        search: [g.name, g.gid, ...this.primaryMembers(g).map(u => u.name), ...g.members].join(' '),
      }));
    return rows.filter(r => terms.every(term => r.search.toLowerCase().includes(term))).sort((a, b) => a.cells[this.sortColumn()].localeCompare(b.cells[this.sortColumn()], undefined, { numeric: true, sensitivity: 'base' }) * (this.descending() ? -1 : 1));
  });
  readonly pages = computed(() => Math.max(1, Math.ceil(this.rows().length / this.size())));
  readonly currentPage = computed(() => Math.min(this.page(), this.pages() - 1));
  readonly visible = computed(() => this.rows().slice(this.currentPage() * this.size(), (this.currentPage() + 1) * this.size()));
  readonly rootCount = computed(() => this.users().filter(u => Number(u.uid) === 0).length);
  readonly addGroups = computed(() => {
    const user = this.selectedUser();
    return user ? this.groups().filter(g => g.gid !== user.gid && !g.members.includes(user.name)) : [];
  });
  readonly addUsers = computed(() => {
    const group = this.selectedGroup();
    return group ? this.users().filter(u => u.gid !== group.gid && !group.members.includes(u.name)) : [];
  });
  primary(user: AccountUser) { return this.groups().filter(g => g.gid === user.gid); }
  primaryLabel(user: AccountUser) { return this.primary(user).map(g => g.name).join(', ') || 'GID ' + user.gid + ' · name unavailable'; }
  supplementary(user: AccountUser) { return this.groups().filter(g => g.members.includes(user.name) && g.gid !== user.gid); }
  primaryMembers(group: AccountGroup) { return this.users().filter(u => u.gid === group.gid); }
  knownUser(name: string) { return this.users().some(u => u.name === name); }
  isPrimary(name: string, group: AccountGroup) { return this.users().some(u => u.name === name && u.gid === group.gid); }
  choose(mode: 'users' | 'groups') { this.mode.set(mode); this.filter.set(''); this.query.set(''); this.sortColumn.set(0); this.descending.set(false); this.page.set(0); }
  sort(index: number) { this.descending.set(this.sortColumn() === index ? !this.descending() : false); this.sortColumn.set(index); this.page.set(0); }
  clear() { this.query.set(''); this.filter.set(''); this.page.set(0); }
  select(kind: 'users' | 'groups', name: string) {
    this.selected.set({ kind, name }); this.addName = '';
    afterNextRender(() => {
      const detail = this.element.nativeElement.querySelector<HTMLElement>('[data-account-detail]');
      detail?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }); detail?.focus({ preventScroll: true });
    }, { injector: this.injector });
  }
  membership(username: string, group: string, add: boolean) {
    if (!this.canManage()) return;
    const user = this.users().find(u => u.name === username), target = this.groups().find(g => g.name === group);
    if (!user || !target || user.gid === target.gid || target.members.includes(username) === add) return;
    this.review.emit({ kind: 'membership', username, group, add });
  }
  status(section: HostSection) {
    return ({ ok: 'Available', denied: 'Permission required', unavailable: 'Tool unavailable', timeout: 'Timed out', error: 'Inspection failed', 'not-collected': 'Not collected' } as Record<string, string>)[section.status] ?? 'Unavailable';
  }
}
