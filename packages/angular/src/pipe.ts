import { Pipe, PipeTransform, inject, Signal } from '@angular/core';
import { ZanzoService } from './service.js';

/**
 * Pure pipe to evaluate ZanzoJS permissions reactively in templates.
 * 
 * @example
 * ```html
 * <button [disabled]="!('edit' | canUse:'Module:ventas')()">Edit</button>
 * ```
 */
@Pipe({
  name: 'canUse',
  standalone: true,
  pure: true
})
export class CanUsePipe implements PipeTransform {
  private readonly zanzo: ZanzoService;

  constructor(zanzo?: ZanzoService) {
    try {
      this.zanzo = zanzo || inject(ZanzoService);
    } catch {
      this.zanzo = zanzo as ZanzoService;
    }
  }

  /**
   * Transforms the action and resource into a reactive Signal<boolean>.
   * 
   * @param action The ReBAC action (e.g. 'read')
   * @param resource The target resource (e.g. 'Document:1')
   */
  transform(action: string, resource: string): Signal<boolean> {
    return this.zanzo._canInternal(action, resource);
  }
}
