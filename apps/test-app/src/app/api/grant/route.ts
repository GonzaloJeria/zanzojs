import { NextRequest, NextResponse } from 'next/server';
import { materializeDerivedTuples, deduplicateTuples } from '@zanzojs/core';
import { engine } from '@/lib/zanzo';
import { db } from '@/db';
import { zanzoTuples } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

/**
 * POST /api/grant
 * Body: { subject: string, relation: string, object: string }
 *
 * Materializes the tuple and its derivations within a single transaction.
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
      // 1. Calculate derivations using the transaction instance for fetchChildren
      const derived = await materializeDerivedTuples({
        schema: engine.getSchema(),
        newTuple: baseTuple,
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

      // 2. Deduplicate to prevent unique constraint failures
      const allToInsert = deduplicateTuples([baseTuple, ...derived]);

      // 3. Batch insert
      tx.insert(zanzoTuples).values(allToInsert).onConflictDoNothing().run();

      return {
        inserted: allToInsert.length,
        base: baseTuple,
        derived,
      };
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error('[Grant API] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
