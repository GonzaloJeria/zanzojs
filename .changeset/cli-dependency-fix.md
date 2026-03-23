---
"@zanzojs/cli": patch
---

fix(cli): Switch unreliable shell NPM package installations to deterministic package.json AST writes to prevent dependency injection failures in unconfigured environments.
