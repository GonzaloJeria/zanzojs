'use client';

import { useZanzo } from '@zanzojs/react';

export default function Home() {
  const { can } = useZanzo();

  const docId = 'doc_1';

  return (
    <main>
      <h1>ZanzoJS + Cloudflare D1 + Next.js</h1>
      <p>Status: {can('read', `Document:${docId}`) ? 'Authorized' : 'Unauthorized'}</p>
      
      {can('edit', `Document:${docId}`) && (
        <button onClick={() => alert('Editing...')}>Edit Document</button>
      )}
    </main>
  );
}
