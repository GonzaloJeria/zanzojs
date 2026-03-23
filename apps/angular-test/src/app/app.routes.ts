import { Routes, Router } from '@angular/router';
import { inject } from '@angular/core';
import { ZanzoService } from '@zanzojs/angular';
import { WorkspaceService } from './workspace.service';
import { DashboardComponent, EditComponent, ExportComponent, UnauthorizedComponent } from './dummy.components';
import { HydrationComponent } from './hydration/hydration.component';
import { PermissionsShowcaseComponent } from './showcase/permissions-showcase.component';

const dynamicGuard = (action: string, moduleSuffix: string) => {
  return () => {
    const zanzo = inject(ZanzoService);
    const ws = inject(WorkspaceService);
    const router = inject(Router);
    
    if (!zanzo.isHydrated()) return router.createUrlTree(['/']);
    
    // Evaluate dynamically against global active workspace
    const hasAccess = zanzo.can(action as any, `Module:${ws.activeWorkspace()}_${moduleSuffix}` as any)();
    return hasAccess ? true : router.createUrlTree(['/unauthorized']);
  };
};

const capabilityGuard = () => {
  return () => {
    const zanzo = inject(ZanzoService);
    const router = inject(Router);
    if (!zanzo.isHydrated()) return router.createUrlTree(['/']);
    
    const hasAccess = zanzo.can('use', 'Capability:export_csv')();
    return hasAccess ? true : router.createUrlTree(['/unauthorized']);
  };
};

export const routes: Routes = [
  {
    path: '',
    component: HydrationComponent,
  },
  {
    path: 'showcase',
    component: PermissionsShowcaseComponent,
  },
  {
    path: 'dashboard',
    component: DashboardComponent,
    canActivate: [dynamicGuard('read', 'ventas')]
  },
  {
    path: 'edit',
    component: EditComponent,
    canActivate: [dynamicGuard('update', 'ventas')]
  },
  {
    path: 'export',
    component: ExportComponent,
    canActivate: [capabilityGuard()]
  },
  {
    path: 'unauthorized',
    component: UnauthorizedComponent
  }
];
