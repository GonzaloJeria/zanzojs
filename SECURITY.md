# Security Policy

## 1. Input Injection
Zanzo prevents control characters and malformed strings at the boundary. The `parseEntityRef` and `validateInput` functions strictly validate input formats (e.g., preventing illegal characters like newlines or colons in IDs). If a developer bypasses the public API and calls `addTuple` directly with a malicious string, the engine is still protected because `addTuple` internally validates the input via `validateInput` (since the security audit sprint).

## 2. Graph Cycle DoS
To prevent infinite loops during ReBAC graph traversal, the `ZanzoEngine` utilizes a `visited` Set with the exact signature `actor|currentTarget|parentSignature`. Furthermore, a hardcoded depth limit of 50 is enforced. If the graph exceeds this depth, the engine throws a `[Zanzo] Security Exception: Maximum relationship depth of 50 exceeded`. In the worst-case scenario—a fully connected graph of N nodes evaluated at depth 50—the traversal is aggressively culled, avoiding exponential complexity and preventing Denial of Service.

## 3. Tuple Expansion DoS
The `expandTuples` and `collapseTuples` functions are safeguarded by the `maxExpansionSize` parameter (default: 500). If a developer's `fetchChildren` callback returns excessively large arrays or deep transitive hierarchies that exceed this limit, the engine will safely abort by throwing a `[Zanzo] Security Exception: Maximum tuple expansion limit of 500 exceeded`. This bounds the memory allocation and execution time at write-time.

## 4. SQL Injection via Drizzle
All user-supplied values in `@zanzo/drizzle` are intrinsically safe from SQL Injection. The adapter relies exclusively on the sql tagged template literal from `drizzle-orm`. Values are always interpolated as bound parameters, never as raw strings. 
Example generated SQL snippet:
```sql
SELECT ... WHERE "subject" = ${actor} AND "relation" = ${relation} AND "object" = ${resource}
```
This results in parameterized queries (e.g., `WHERE "subject" = $1 AND "relation" = $2 AND "object" = $3`), preventing syntax interference from user input.

## 5. Snapshot Staleness
The `ZanzoClient` operates on a compiled "snapshot" representing authorizations at a specific point in time. If backend permissions change in the database after the snapshot is compiled, the client will continue using the stale snapshot, potentially allowing or denying actions incorrectly until refreshed. 
To mitigate this tradeoff, we recommend three strategies:
- **TTL with periodic revalidation:** Re-fetch the snapshot every N minutes.
- **Invalidation via Webhook:** Listen to tuple changes on the backend and push an invalidation event to clients via WebSockets.
- **Re-fetch on critical navigation:** Forcefully compile and fetch a new snapshot when the user navigates to highly sensitive routes (e.g., billing or settings).

## 6. Prototype Pollution
The engine and client are immune to prototype pollution vectors. Dictionary lookups utilize `Map.get()` internally, which is impervious to the `__proto__` pollution attack vector. Additionally, the snapshot compiler carefully builds its plain object representation using `Object.create(null)`, ensuring that the resulting JSON has no inheritance chain and avoids inadvertent collisions with Object prototype methods.

## Reporting Vulnerabilities
If you discover a security vulnerability in Zanzo, please report it via responsible disclosure. Open a private security advisory on the GitHub repository or contact the maintainers directly by email before making any public disclosure. Our SLA for the initial response to security reports is 72 hours.
