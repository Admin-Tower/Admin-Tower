import { Component, DestroyRef, ElementRef, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { Host, HostsService } from '../../hosts/hosts.service';

@Component({
  selector: 'tower-live-htop', imports: [MatButtonModule, DatePipe],
  templateUrl: './live-htop.html', styleUrl: './live-htop.scss',
})
export class LiveHtop {
  readonly host = input.required<Host>();
  readonly disabled = input(false);
  readonly service = inject(HostsService);
  readonly screen = viewChild.required<ElementRef<HTMLDivElement>>('screen');
  readonly filterKey = String.fromCharCode(92);
  readonly busy = signal(false);
  readonly opened = signal(false);
  readonly session = signal<string | null>(null);
  readonly status = signal('Not connected');
  readonly error = signal('');
  readonly updated = signal<number | null>(null);
  private terminal?: Terminal;
  private fit?: FitAddon;
  private observer?: ResizeObserver;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private destroyed = false;
  private target = '';
  constructor() {
    effect(() => {
      const target = JSON.stringify(this.host());
      if (this.target && target !== this.target) { untracked(() => { void this.stop(); this.status.set('Host settings changed. Start a new session.'); }); }
    });
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true; ++this.generation; clearTimeout(this.timer);
      const id = this.session(); if (id) void this.service.stopHtop(id).catch(() => undefined);
      this.dispose();
    });
  }
  private dispose() { this.observer?.disconnect(); this.observer = undefined; this.terminal?.dispose(); this.terminal = undefined; this.fit = undefined; }
  async start() {
    if (this.busy() || this.session() || this.disabled() || !this.service.desktop) return;
    const generation = ++this.generation;
    this.target = JSON.stringify(this.host()); this.busy.set(true); this.error.set(''); this.status.set('Connecting…'); this.opened.set(true); this.updated.set(null);
    this.dispose();
    try {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      if (this.destroyed || generation !== this.generation) return;
      const terminal = new Terminal({ cols: 100, rows: 28, fontSize: 13, fontFamily: 'monospace', scrollback: 0, screenReaderMode: true, disableStdin: true, theme: { background: '#111820', foreground: '#e6edf3' }, allowProposedApi: false });
      this.terminal = terminal; this.fit = new FitAddon(); terminal.loadAddon(this.fit);
      // Never allow remote terminal sequences to write to the desktop clipboard.
      terminal.parser.registerOscHandler(52, () => true);
      terminal.open(this.screen().nativeElement);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (this.destroyed || generation !== this.generation) return;
      this.resize();
      const id = await this.service.startHtop(this.host().id, terminal.cols, terminal.rows);
      if (this.destroyed || generation !== this.generation) { await this.service.stopHtop(id); return; }
      this.session.set(id); terminal.options.disableStdin = false; this.status.set('Session opening…'); terminal.focus();
      terminal.onData(data => {
        if (this.session() !== id || !data) return;
        if (new TextEncoder().encode(data).length > 1024) { this.error.set('Input is too large. Use short search/filter text.'); return; }
        void this.service.inputHtop(id, data).catch(error => this.error.set(this.message(error)));
      });
      this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(this.screen().nativeElement);
      void this.pump(id, generation);
    } catch (error) {
      if (generation === this.generation && !this.destroyed) { this.error.set(this.message(error)); this.status.set('Could not start htop'); }
    } finally { if (generation === this.generation && !this.destroyed) this.busy.set(false); }
  }
  private resize() {
    const terminal = this.terminal, proposed = this.fit?.proposeDimensions(); if (!terminal || !proposed) return;
    const cols = Math.max(20, Math.min(400, proposed.cols)), rows = Math.max(8, Math.min(150, proposed.rows));
    if (cols === terminal.cols && rows === terminal.rows) return;
    terminal.resize(cols, rows);
    const id = this.session();
    if (id) void this.service.resizeHtop(id, cols, rows).catch(error => this.error.set(this.message(error)));
  }
  private async pump(id: string, generation: number) {
    try {
      const frame = await this.service.pollHtop(id);
      if (this.destroyed || generation !== this.generation) return;
      this.status.set(frame.message);
      if (frame.data) {
        const bytes = Uint8Array.from(atob(frame.data), char => char.charCodeAt(0));
        this.updated.set(Date.now());
        await new Promise<void>(resolve => this.terminal?.write(bytes, resolve));
      }
      if (this.destroyed || generation !== this.generation) return;
      if (frame.ended) {
        this.session.set(null); if (this.terminal) this.terminal.options.disableStdin = true;
        this.observer?.disconnect(); await this.service.stopHtop(id); return;
      }
      this.timer = setTimeout(() => { void this.pump(id, generation); }, 100);
    } catch (error) {
      if (this.destroyed || generation !== this.generation) return;
      this.error.set(this.message(error)); await this.stop(); this.status.set('Session disconnected');
    }
  }
  async stop() {
    ++this.generation; clearTimeout(this.timer); this.busy.set(false);
    const id = this.session(); this.session.set(null); this.observer?.disconnect();
    if (this.terminal) this.terminal.options.disableStdin = true;
    this.status.set('Session stopped');
    if (id) { try { await this.service.stopHtop(id); } catch (error) { if (!this.destroyed) this.error.set(this.message(error)); } }
  }
  key(data: string) { const id = this.session(); if (id) { void this.service.inputHtop(id, data).catch(error => this.error.set(this.message(error))); this.terminal?.focus(); } }
  private message(error: unknown) { return error instanceof Error ? error.message : String(error); }
}
