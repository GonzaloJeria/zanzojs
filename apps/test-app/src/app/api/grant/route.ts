import { NextRequest, NextResponse } from 'next/server';
import { expandTuples } from '@zanzojs/core';
import { engine } from '@/lib/zanzo';
import { db } from '@/db';
import { zanzoTuples } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

/**
 * POST /api/grant
 * Body: { subject: string, relation: string, object: string }
 *
 * Expands the tuple using expandTuples() and inserts base + derived tuples.
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

  const derivedTuples = await expandTuples({
    schema: engine.getSchema(),
    newTuple: baseTuple,
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

  const allTuples = [baseTuple, ...derivedTuples];
  db.insert(zanzoTuples).values(allTuples).run();

  return NextResponse.json({
    inserted: allTuples.length,
    base: baseTuple,
    derived: derivedTuples,
  });
}
