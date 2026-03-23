import { InjectionToken } from '@angular/core';
import { SchemaData } from '@zanzojs/core';

export interface ZanzoConfig {
  /**
   * The ZanzoJS schema definition.
   * Used for O(1) in-memory evaluations.
   */
  schema: SchemaData;

  /**
   * Redirection target for guards when permission is denied.
   * @default '/unauthorized'
   */
  unauthorizedRoute?: string;

  /**
   * Optional key to look for in TransferState during SSR/Hydration.
   * If provided, ZanzoService will automatically hydrate itself if the key is found.
   */
  snapshotKey?: string;
}

export const ZANZO_CONFIG = new InjectionToken<ZanzoConfig>('ZANZO_CONFIG');
