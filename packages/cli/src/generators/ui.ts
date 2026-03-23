import * as fs from 'node:fs';
import * as path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';

export async function generateUI(template: string | string[], framework: string, outputDir: string): Promise<void> {
  // Only inject UI for App Router currently
  if (framework !== 'nextjs-app' || Array.isArray(template)) {
    return;
  }

  const appDir = path.resolve(outputDir, 'app');
  if (!fs.existsSync(appDir)) {
    fs.mkdirSync(appDir, { recursive: true });
  }

  p.log.info(pc.blue('Injecting interactive UI components for ' + template + ' template...'));

  if (template === 'b2b') {
    const dashboardDir = path.resolve(appDir, 'dashboard');
    fs.mkdirSync(dashboardDir, { recursive: true });

    const code = `import React from 'react';

/**
 * ZanzoJS B2B Premium Dashboard
 * This component visually demonstrates permission resolution.
 */
export default function Dashboard() {
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-10 font-sans">
      <div className="max-w-5xl mx-auto">
        <header className="flex justify-between items-center mb-12 border-b border-neutral-800 pb-6">
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent">
            Workspace Dashboard
          </h1>
          <div className="flex items-center gap-4">
            <span className="text-sm px-3 py-1 bg-neutral-900 border border-neutral-800 rounded-full text-indigo-300">
              Role: Admin
            </span>
            <button className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 transition-colors rounded-md text-sm font-medium shadow-lg shadow-indigo-900/20">
              Invite Members
            </button>
          </div>
        </header>

        <main className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="col-span-2 space-y-6">
            <section className="bg-neutral-900/50 border border-neutral-800 rounded-xl p-6 backdrop-blur-xl">
              <h2 className="text-xl font-semibold mb-4 text-neutral-200">Documents</h2>
              <div className="space-y-3">
                {[1, 2, 3].map(id => (
                  <div key={id} className="group flex items-center justify-between p-4 bg-neutral-900 border border-neutral-800 hover:border-neutral-700 rounded-lg transition-all duration-300">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded bg-indigo-900/40 flex items-center justify-center text-indigo-400">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                      </div>
                      <div>
                        <h3 className="font-medium text-neutral-200 group-hover:text-indigo-300 transition-colors">Q{id} Financial Report</h3>
                        <p className="text-xs text-neutral-500">Workspace 1 • Edited 2h ago</p>
                      </div>
                    </div>
                    <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button className="px-3 py-1.5 text-xs font-medium bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded">Edit</button>
                      {/* Zanzo Check: Only Workspace Owner/Admin can delete */}
                      <button className="px-3 py-1.5 text-xs font-medium bg-red-900/20 hover:bg-red-900/40 text-red-400 border border-red-900/30 rounded transition-colors">Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div className="col-span-1 space-y-6">
            <section className="bg-neutral-900/50 border border-neutral-800 rounded-xl p-6">
              <h2 className="text-lg font-semibold mb-4 text-neutral-200">System Capabilities</h2>
              <ul className="space-y-3">
                <li className="flex items-center gap-3 text-sm text-neutral-400 border-b border-neutral-800 pb-3">
                  <div className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]"></div>
                  <span>export_csv (Granted)</span>
                </li>
                <li className="flex items-center gap-3 text-sm text-neutral-500 line-through">
                  <div className="w-2 h-2 rounded-full bg-neutral-700"></div>
                  <span>audit_logs (Denied)</span>
                </li>
              </ul>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}`;
    fs.writeFileSync(path.resolve(dashboardDir, 'page.tsx'), code, 'utf-8');
    p.log.success('Created B2B Dashboard UI in app/dashboard');

  } else if (template === 'social') {
    const feedDir = path.resolve(appDir, 'feed');
    fs.mkdirSync(feedDir, { recursive: true });

    const code = `import React from 'react';

/**
 * ZanzoJS UGC Feed / Social Media Demo
 */
export default function Feed() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-4xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-pink-500 to-orange-400 mb-8">
          Community Feed
        </h1>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 mb-8 transform transition hover:shadow-md">
          <textarea 
            className="w-full bg-slate-50 rounded-xl border-none p-4 text-slate-700 focus:ring-2 focus:ring-pink-500/20 outline-none resize-none" 
            placeholder="Share an update with your group..."
            rows={3}
          ></textarea>
          <div className="flex justify-end mt-4">
            <button className="px-6 py-2 bg-slate-900 text-white rounded-full font-medium hover:bg-slate-800 transition shadow-lg shadow-slate-200">
              Post
            </button>
          </div>
        </div>

        <div className="space-y-6">
          <article className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 group">
            <div className="flex justify-between items-start mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-pink-400 to-purple-500 p-0.5">
                  <div className="w-full h-full bg-white rounded-full border-2 border-white"></div>
                </div>
                <div>
                  <h3 className="font-semibold text-slate-800">Gonzalo Jeria</h3>
                  <p className="text-xs text-slate-500">Moderator • Group: TypeScript Devs</p>
                </div>
              </div>
              <div className="flex gap-2">
                {/* Moderation permissions based on Zanzo */}
                <button className="text-slate-400 hover:text-red-500 transition-colors p-2">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                </button>
              </div>
            </div>
            <p className="text-slate-600 leading-relaxed">
              Just released ZanzoJS v0.3.3 natively integrating granular React scaffolding! The edge compatibility is insanely fast.
            </p>
          </article>
        </div>
      </div>
    </div>
  );
}`;
    fs.writeFileSync(path.resolve(feedDir, 'page.tsx'), code, 'utf-8');
    p.log.success('Created UGC Feed UI in app/feed');
  }
}
