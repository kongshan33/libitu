# Query First Design

Design order:

business scenario
→ query
→ index
→ schema

Process:

1 Define access pattern
2 Define query
3 Define index
4 Generate schema

Example:

Requirement:
show recent learning

Query:

WHERE user_id=?
ORDER BY updated_at DESC
LIMIT 20

Index:

(user_id,updated_at)

Avoid:

entity
→ schema
→ query


## Join Strategy

Prefer:

join <= 4

When exceeded:

materialized view

cache

aggregate table

prefer cursor pagination

avoid:

select *