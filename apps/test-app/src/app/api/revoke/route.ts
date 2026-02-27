import { NextRequest, NextResponse } from 'next/server';
import { collapseTuples } from '@zanzojs/core';
import { engine } from '@/lib/zanzo';
import { db } from '@/db';
import { zanzoTuples } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

/**
 * POST /api/revoke
 * Body: { subject: string, relation: string, object: string }
 *
 * Collapses the tuple using collapseTuples() and deletes base + derived tuples.
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

  const derivedTuples = await collapseTuples({
    schema: engine.getSchema(),
    revokedTuple: baseTuple,
    fetchChildren: async (parentObject: string, relationToChildren: string) => {
      const rows = db
        .select({ object: zanzoTuples.object })
        .from(zanzoTuples)
        .where(
          and(
            eq(zanzoTuples.subject, parentObject),
            eq(zanzoTuples.relation, relationToChildren),
          ),
        )
        .all();
      return rows.map((r) => r.object);
    },
  });

  // Delete all derived tuples first, then the base tuple
  const allToDelete = [baseTuple, ...derivedTuples];
  let deleted = 0;

  for (const tuple of allToDelete) {
    const result = db
      .delete(zanzoTuples)
      .where(
        and(
          eq(zanzoTuples.subject, tuple.subject),
          eq(zanzoTuples.relation, tuple.relation),
          eq(zanzoTuples.object, tuple.object),
        ),
      )
      .run();
    deleted += result.changes;
  }

  return NextResponse.json({
    deleted,
    base: baseTuple,
    derived: derivedTuples,
  });
}
