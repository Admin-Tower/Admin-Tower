import { Route } from '@angular/router';

export const appRoutes: Route[] = [
  { path: '', redirectTo: 'hosts', pathMatch: 'full' },
  { path: 'hosts/:id', loadComponent: () => import('./host-detail/host-detail').then(m => m.HostDetail) },
  { path: 'hosts', loadComponent: () => import('./hosts/hosts').then(m => m.Hosts) },
];
