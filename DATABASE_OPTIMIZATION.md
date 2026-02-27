## 🗄️ Database Optimization (The Zanzibar Pattern)

To ensure Zanzo evaluates millions of queries instantly, you must configure your database correctly.

If you are using `@zanzo/drizzle`, your Universal Tuple table must have these **Compound Indexes** at a minimum:

```typescript
// PostgreSQL Example
import { pgTable, text, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const zanzoTuples = pgTable('zanzo_tuples', {
    object: text('object').notNull(),
    relation: text('relation').notNull(),
    subject: text('subject').notNull(),
  }, (t) => ({
    // 1. PRIMARY LOOKUP: Used when verifying "Does X have Y access to Z?"
    // Most ReBAC read paths hit this index guaranteeing O(1) or O(log N) DB lookups.
    idx_object_relation_subject: uniqueIndex('idx_zanzo_ors')
      .on(t.object, t.relation, t.subject),

    // 2. REVERSE LOOKUP: Used when verifying "What resources does User X have access to?"
    // (Used during nested recursive queries querying backward).
    idx_subject_relation: index('idx_zanzo_sr')
      .on(t.subject, t.relation)
  })
);
```

### Why these exact Indexes?
Zanzo (and Zanzibar implementations globally) rely intensely on specific access patterns. Random index generation will cause full-table-scans (`Seq Scan`). Combining `object` + `relation` + `subject` as a compound B-TREE guarantees the ORM prepared statement locks the row almost instantly without touching RAM.
