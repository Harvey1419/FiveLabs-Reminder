// Physical entity write contract from infrastructure/database/schema.sql.
// Legacy read/presentation categories (including pet) are intentionally separate.
export const ENTITY_WRITE_CATEGORIES = Object.freeze([
  'person', 'company', 'project', 'asset', 'place', 'other',
]);
