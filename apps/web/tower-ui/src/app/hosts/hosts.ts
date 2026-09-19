import { RouterLink } from '@angular/router';
import { afterNextRender, Component, ElementRef, Injector, computed, inject, OnInit, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Host, HostsService, IdentityOptions, Terminal } from './hosts.service';

@Component({
  selector: 'tower-hosts',
  imports: [RouterLink, ReactiveFormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule],
  templateUrl: './hosts.html',
  styleUrl: './hosts.scss'
})
export class Hosts implements OnInit {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  readonly sort = signal('name');
  readonly service = inject(HostsService);
  private readonly fb = inject(FormBuilder);
  readonly hosts = signal<Host[]>([]);
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
    return this.hosts().filter(({ settings: h }) => `${h.name} ${h.address} ${h.username}`.toLowerCase().includes(search)).sort((a, b) => {
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

  ngOnInit() { if (this.service.desktop) void this.refresh(); }

  async refresh() {
    await this.perform(async () => {
      const [hosts, identities, terminals] = await Promise.all([this.service.list(), this.service.identities(), this.service.terminals()]);
      this.hosts.set(hosts);
      this.identities.set(identities);
      this.terminals.set(terminals);
      if (!terminals.some(t => t.id === this.terminal())) this.terminal.set(terminals[0]?.id ?? '');
      this.loaded.set(true);
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
    });
  }

  async remove(host: Host) {
    await this.perform(async () => {
      await this.service.delete(host.id);
      this.hosts.update(hosts => hosts.filter(h => h.id !== host.id));
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
