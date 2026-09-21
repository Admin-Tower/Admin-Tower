import { Route } from '@angular/router';

export const appRoutes: Route[] = [
  { path: '', redirectTo: 'hosts', pathMatch: 'full' },
  { path: 'hosts/:id', loadComponent: () => import('./host-detail/host-detail').then(m => m.HostDetail) },
  { path: 'automation/ping', loadComponent: () => import('./automation/ping/ping').then(m => m.Ping) },
  { path: 'automation/packages', loadComponent: () => import('./automation/packages/packages').then(m => m.Packages) },
  { path: 'automation/reboot', loadComponent: () => import('./automation/reboot/reboot').then(m => m.Reboot) },
  { path: 'automation', loadComponent: () => import('./automation/automation').then(m => m.Automation) },
  { path: 'groups', loadComponent: () => import('./groups/groups').then(m => m.Groups) },
  { path: 'hosts', loadComponent: () => import('./hosts/hosts').then(m => m.Hosts) },
];
