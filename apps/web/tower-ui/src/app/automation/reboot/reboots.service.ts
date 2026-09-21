import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { Host } from '../../hosts/hosts.service';
import { AutomationTargets } from '../automation.service';

export interface RebootRun {
  id: string;
  targetLabel: string;
  phase: 'preview' | 'review' | 'apply' | 'finished';
  active: boolean;
  stopRequested: boolean;
  results: {
    host: Host;
    state: 'waiting' | 'ready' | 'launching' | 'running' | 'unknown' | 'successful' | 'failed' | 'skipped';
    message: string;
    logs: string;
    rebootRequired: boolean;
    plan: { bootId: string; sshStartup?: string; os: string; createdAt: number; requestedBy: string[]; failedServices: string[] } | null;
  }[];
}
@Injectable({ providedIn: 'root' })
export class RebootsService {
  preview(targets: AutomationTargets) { return invoke<RebootRun>('preview_reboots', { targets }); }
  latest() { return invoke<RebootRun | null>('latest_reboots'); }
  apply(runId: string) { return invoke<RebootRun>('apply_reboots', { runId }); }
  refresh(runId: string) { return invoke<RebootRun>('refresh_reboots', { runId }); }
  stop(runId: string) { return invoke<void>('stop_reboots', { runId }); }
}
