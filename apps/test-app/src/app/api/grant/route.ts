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
  const adminId = request.headers.get('x-admin-id') || 'alice'; // Mock admin check

  // REAL-WORLD REBAC TIP:
  // Before granting, you should check if the CURRENT user is authorized to manage this resource.
  // const isAuthorized = await engine.for(`User:${adminId}`).can('admin').on(object);
  // if (!isAuthorized) return NextResponse.json({ error: 'Unauthorized to manage permissions' }, { status: 403 });

  if (!subject || !relation || !object) {
    return NextResponse.json(
      { error: 'Missing required fields: subject, relation, object' },
      { status: 400 },
    );
  }

  const baseTuple = { subject, relation, object };

  try {
    // 1. Calculate derivations OUTSIDE the transaction
    // (materializeDerivedTuples is async, but better-sqlite3 transactions are sync)
    const derived = await materializeDerivedTuples({
      schema: engine.getSchema(),
      newTuple: baseTuple,
      fetchChildren: async (parent, rel) => {
        // We use the standard 'db' instance here as it's safe for reads in SQLite
        const rows = db
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

    // 2. Open a synchronous transaction for writes
    const result = db.transaction((tx) => {
      const allToInsert = deduplicateTuples([baseTuple, ...derived]);
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
