---
"@zanzojs/core": minor
"@zanzojs/cli": patch
---

Zanzibar userset rewrites in the core engine:

- core: permissions accept expressions with union (`|`), intersection (`&`), exclusion (`-`), permissions that reference other permissions, and `relation->permission` inheritance, including recursive inheritance (`viewer | parent->view`). Arrays of paths keep working.
- core: relations accept several subject types, public wildcards (`'User:*'`) and usersets (`'Group#member'`), so groups can be nested. Grant them with `to('User:*')` and `to('Group:eng#member')`.
- core: `actions` is optional in `ZanzoBuilder.entity()`; when omitted, the permission names are the actions.
- core: schemas are compiled once into an intermediate representation and fully validated: every path segment, userset targets and permissions that reference themselves (`ZANZO_INVALID_SCHEMA`).
- core: `buildDatabaseQuery` inlines permissions that reference other permissions, and throws `ZANZO_UNSUPPORTED_FEATURE` for constructs the SQL adapter cannot evaluate yet instead of returning wrong conditions.
- core: faster checks (direct −24%, nested −27%, denied −52%) and snapshots (−53%).
- cli: `zanzo check` understands the expression syntax, multi-type relations, wildcards and usersets.
