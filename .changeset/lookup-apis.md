---
"@zanzojs/core": minor
---

Zanzibar lookup APIs:

- `engine.lookupResources(actor, action, type)`: the resources of a type an actor can access.
- `engine.lookupSubjects(resource, action, subjectType)`: who has a permission on a resource, including whether a public wildcard grants it and which related subjects are still excluded.
- `engine.expand(resource, action)`: the rule tree and direct subjects that grant a permission, to debug and explain access.
- `engine.read(filter)`: stored tuples by object, relation and/or subject.
