import { NextRequest, NextResponse } from 'next/server';
import { ZanzoEngine, createZanzoSnapshot } from '@zanzojs/core';
import { schema } from '@/lib/zanzo';
import { db } from '@/db';
import { zanzoTuples } from '@/db/schema';
import { like, or } from 'drizzle-orm';

/**
 * GET /api/permissions?userId=alice
 *
 * Loads all tuples for the given user from SQLite,
 * builds the engine in-memory, and returns the compiled snapshot.
 */
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get('userId');

  if (!userId) {
    return NextResponse.json(
      { error: 'Missing userId query parameter' },
      { status: 400 },
    );
  }

  const actor = `User:${userId}`;

  // Load ALL tuples that reference this user as subject OR object
  const userTuples = db
    .select()
    .from(zanzoTuples)
    .where(
      or(
        like(zanzoTuples.subject, actor),
        like(zanzoTuples.object, actor)
      )
    )
    .all();

  // Create a fresh engine for this request and hydrate it
  const requestEngine = new ZanzoEngine(schema);

  // Also load structural tuples (Module→workspace→Workspace) so the
  // engine can walk the full relationship graph for permission evaluation.
  const structuralTuples = db
    .select()
    .from(zanzoTuples)
    .where(like(zanzoTuples.relation, 'workspace'))
    .all();

  requestEngine.load([...structuralTuples, ...userTuples]);

  // Compile the flat snapshot for the frontend
  const snapshot = createZanzoSnapshot(requestEngine, actor);

  return NextResponse.json(snapshot);
}
