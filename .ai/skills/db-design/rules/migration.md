# Migration

Workflow:

migration
→ apply
→ generate types

Structure:

db/
migrations/
schema/
seed/

Avoid:

modify schema directly
breaking migration

Workflow:
always:

forward only

steps:

add
backfill
deploy
remove