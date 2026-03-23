import { Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class WorkspaceService {
  // Global active workspace state
  public activeWorkspace = signal('ws1');
}
