---
name: db-design
description:
Design scalable relational database schemas.
---

Workflow:

1. Clarify requirements
2. Identify entities
3. Identify aggregates
4. Draw relationships
5. Define constraints
6. Define indexes
7. Generate migrations
8. Generate repositories
9. Generate seeds
10. Review query cost

Output:

- ERD
- SQL
- Migration
- Example query

Never:

- schema without access pattern
- nullable by default
- json for relational data
- composite PK unless necessary


Load:

- rules/schema.md
- rules/query.md
- rules/migration.md
- rules/anti-patterns.md