// Admin - acceso completo en WS1, solo vista en WS2
export const adminSnapshot: Record<string, string[]> = {
  // Global / Capabilities
  'Capability:export_csv': ['use'],
  
  // Workspace 1
  'Workspace:ws1': ['access', 'admin'],
  'Module:ws1_ventas': ['create', 'read', 'update', 'delete', 'manager'],
  'Module:ws1_stock': ['read', 'update', 'editor'],
  
  // Workspace 2
  'Workspace:ws2': ['access', 'member'],
  'Module:ws2_ventas': ['read', 'viewer'],
  'Module:ws2_stock': ['read', 'viewer'],
};

// Viewer - solo lectura en WS1, sin acceso a WS2
export const viewerSnapshot: Record<string, string[]> = {
  // Workspace 1
  'Workspace:ws1': ['access', 'member'],
  'Module:ws1_ventas': ['read', 'viewer'],
  'Module:ws1_stock': ['read', 'viewer'],
};
