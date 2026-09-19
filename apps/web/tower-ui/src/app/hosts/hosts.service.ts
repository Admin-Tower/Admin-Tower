import { Injectable } from '@angular/core';
import { invoke, isTauri } from '@tauri-apps/api/core';

export type Authentication =
  | { kind: 'agent'; fingerprint: string }
  | { kind: 'keyFile'; filename: string };

export interface HostInput {
  name: string;
  address: string;
  username: string;
  port: number;
  authentication: Authentication;
}
export interface Host { id: string; settings: HostInput }
export interface IdentityOptions {
  agentIdentities: { fingerprint: string; algorithm: string }[];
  keyFiles: string[];
  agentError: string | null;
  keyError: string | null;
}
export interface HtopFrame { data: string; ended: boolean; message: string }
export interface Terminal { id: string; label: string }

export type HostAction =
  | { kind: 'createUser'; username: string }
  | { kind: 'createGroup'; group: string }
  | { kind: 'membership'; username: string; group: string; add: boolean }
  | { kind: 'service'; unit: string; verb: 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable' }
  | { kind: 'inspect'; elevated: boolean };
export interface HostSection { id: string; status: string; output: string; truncated: boolean }
export interface HostOverview { target?: Host | null; collectedAt: number; elevated: boolean; supported: boolean; sections: HostSection[] }
export interface ActionReview { id: string; host: Host; summary: string; command: string; warning: string; expiresAt: number }
export interface HostOperation { id: string; hostId: string; state: string; message: string; overview: HostOverview | null }

@Injectable({ providedIn: 'root' })
export class HostsService {
  readonly desktop = isTauri();

  private call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (!this.desktop) return Promise.reject(new Error('Host inventory requires the Linux desktop app.'));
    return invoke<T>(command, args);
  }

  startHtop(id: string, cols: number, rows: number) { return this.call<string>('start_htop', { id, cols, rows }); }
  pollHtop(sessionId: string) { return this.call<HtopFrame>('poll_htop', { sessionId }); }
  inputHtop(sessionId: string, data: string) { return this.call<void>('input_htop', { sessionId, data }); }
  resizeHtop(sessionId: string, cols: number, rows: number) { return this.call<void>('resize_htop', { sessionId, cols, rows }); }
  stopHtop(sessionId: string) { return this.call<void>('stop_htop', { sessionId }); }
  inspect(id: string) { return this.call<HostOverview>('inspect_host', { id }); }
  review(id: string, action: HostAction) { return this.call<ActionReview>('review_host_action', { id, action }); }
  start(reviewId: string, terminal: string) { return this.call<HostOperation>('start_host_action', { reviewId, terminal }); }
  operation(id: string, operationId: string) { return this.call<HostOperation>('get_host_operation', { id, operationId }); }
  list() { return this.call<Host[]>('list_hosts'); }
  identities() { return this.call<IdentityOptions>('list_identities'); }
  terminals() { return this.call<Terminal[]>('list_terminals'); }
  save(id: string | null, settings: HostInput) { return this.call<Host>('save_host', { id, settings }); }
  delete(id: string) { return this.call<void>('delete_host', { id }); }
  connect(id: string, terminal: string) { return this.call<void>('connect_host', { id, terminal }); }
}
