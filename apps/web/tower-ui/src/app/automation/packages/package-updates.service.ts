import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { Host } from '../../hosts/hosts.service';
import { AutomationTargets } from '../automation.service';

export interface PackagePlan {
  os: string;
  createdAt: number;
  packages: { name: string; fromVersion: string; toVersion: string }[];
  failedServices: string[];
  deferred: string[];
}
export interface PackageRun {
  id: string;
  targetLabel: string;
  phase: 'preview' | 'review' | 'apply' | 'finished';
  active: boolean;
  stopRequested: boolean;
  results: {
    host: Host;
    state: 'waiting' | 'ready' | 'launching' | 'running' | 'unknown' | 'successful' | 'failed' | 'skipped';
    message: string;
    logs?: string;
    logError?: string;
    plan: PackagePlan | null;
    rebootRequired: boolean;
  }[];
}
@Injectable({ providedIn: 'root' })
export class PackageUpdatesService {
  preview(targets: AutomationTargets) { return invoke<PackageRun>('preview_packages', { targets }); }
  latest() { return invoke<PackageRun | null>('latest_packages'); }
  apply(runId: string) { return invoke<PackageRun>('apply_packages', { runId }); }
  refresh(runId: string) { return invoke<PackageRun>('refresh_packages', { runId }); }
  stop(runId: string) { return invoke<void>('stop_packages', { runId }); }
}
