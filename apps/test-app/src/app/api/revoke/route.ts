import { NextRequest, NextResponse } from 'next/server';
import { removeDerivedTuples, buildBulkDeleteCondition } from '@zanzojs/core';
import { engine } from '@/lib/zanzo';
import { db } from '@/db';
import { zanzoTuples } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

/**
 * POST /api/revoke
 * Body: { subject: string, relation: string, object: string }
 *
 * Collapses the tuple and its derivations within a single transaction.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { subject, relation, object } = body;

  if (!subject || !relation || !object) {
    return NextResponse.json(
      { error: 'Missing required fields: subject, relation, object' },
      { status: 400 },
    );
  }

  const baseTuple = { subject, relation, object };

  try {
    const result = await db.transaction(async (tx) => {
      // 1. Calculate derivations to remove
      const derived = await removeDerivedTuples({
        schema: engine.getSchema(),
        revokedTuple: baseTuple,
        fetchChildren: async (parent, rel) => {
          const rows = tx
            .select({ object: zanzoTuples.object })
            .from(zanzoTuples)
            .where(
              and(
                eq(zanzoTuples.subject, parent),
                eq(zanzoTuples.relation, rel),
              ),
            )
            .all();
          return rows.map((r) => r.object);
        },
      });

      const allToDelete = [baseTuple, ...derived];
      const conditions = buildBulkDeleteCondition(allToDelete);

      let deleted = 0;
      // 2. Perform bulk deletion
      for (const [sub, rel, obj] of conditions) {
        const res = tx
          .delete(zanzoTuples)
          .where(
            and(
              eq(zanzoTuples.subject, sub),
              eq(zanzoTuples.relation, rel),
              eq(zanzoTuples.object, obj),
            ),
          )
          .run();
        deleted += res.changes;
      }

      return {
        deleted,
        base: baseTuple,
        derived,
      };
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error('[Revoke API] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
