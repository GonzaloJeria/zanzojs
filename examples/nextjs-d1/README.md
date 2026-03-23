# ZanzoJS + Cloudflare D1 + Next.js Example

This example demonstrates how to integrate ZanzoJS into a Next.js application deployed on Cloudflare Pages using Cloudflare D1 as the ReBAC Tuple storage.

## Setup Instructions

1.  **Clone and install dependencies:**
    ```bash
    pnpm install
    ```

2.  **Initialize D1 Database:**
    Create a D1 database using Wrangler:
    ```bash
    npx wrangler d1 create zanzo-db
    ```
    Copy the `database_id` from the output and paste it into `wrangler.toml`.

3.  **Run Migrations:**
    Apply the initial schema to your D1 database:
    ```bash
    npx wrangler d1 execute zanzo-db --local --file=./migrations/0000_initial.sql
    ```

4.  **Seed Some Data (Optional):**
    ```bash
    npx wrangler d1 execute zanzo-db --local --command="INSERT INTO zanzo_tuples (subject, relation, object) VALUES ('User:1', 'owner', 'Workspace:1');"
    npx wrangler d1 execute zanzo-db --local --command="INSERT INTO zanzo_tuples (subject, relation, object) VALUES ('Workspace:1', 'workspace', 'Document:doc_1');"
    -- Note: Nested permissions like workspace.owner require materialized tuples in the DB.
    npx wrangler d1 execute zanzo-db --local --command="INSERT INTO zanzo_tuples (subject, relation, object) VALUES ('User:1', 'workspace.owner', 'Document:doc_1');"
    ```

5.  **Run Locally:**
    ```bash
    pnpm run pages:dev
    ```

## Deployment & Best Practices

### 🛡️ Pre-deployment Checks
Before deploying to Cloudflare Pages, it is highly recommended to run the Zanzo linter to ensure your authorization graph is optimized for the Edge Runtime:

```bash
npx @zanzojs/cli@latest check
```
This will verify that your schema does not generate overly complex ASTs (conditional branches) that could exceed Cloudflare's CPU limits.

## Key Files

- `zanzo.config.ts`: Your authorization schema.
- `app/layout.tsx`: Server Component that generates the Zanzo snapshot from D1.
- `app/page.tsx`: Client Component that uses `useZanzo` for instant checks.
- `drizzle/schema.ts`: Drizzle schema including the `zanzo_tuples` universal table.
