import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { Host } from '../hosts/hosts.service';

export interface HostGroup { id: string; name: string; memberIds: string[] }
export interface AutomationTargets { hostIds: string[]; groupIds: string[] }
export interface PingRun {
  logs?: string;
  id: string; targetLabel: string; active: boolean; elapsedMs: number; message: string;
  results: { host: Host; outcome: 'waiting' | 'successful' | 'unreachable' | 'failed' | 'cancelled' | 'timed-out'; diagnostics: string }[];
}
@Injectable({ providedIn: 'root' })
export class AutomationService {
  groups() { return invoke<HostGroup[]>('list_host_groups'); }
  save(id: string | null, name: string, memberIds: string[]) { return invoke<HostGroup>('save_host_group', { id, name, memberIds }); }
  delete(id: string) { return invoke<void>('delete_host_group', { id }); }
  availability() { return invoke<string>('ansible_availability'); }
  startQuick(hostId: string) { return invoke<PingRun>('start_quick_ping', { hostId }); }
  latestQuick(hostId: string) { return invoke<PingRun | null>('latest_quick_ping', { hostId }); }
  start(targets: AutomationTargets) { return invoke<PingRun>('start_ping', { targets }); }
  latest() { return invoke<PingRun | null>('latest_ping'); }
  cancel(runId: string) { return invoke<void>('cancel_ping', { runId }); }
}
