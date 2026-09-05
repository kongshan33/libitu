# Schema Rules

Prefer:

normalized relational schema

Allow JSON only:

- metadata
- cache
- embedding
- event

Avoid:

profile JSONB

Bad:

user.profile

Good:

user
user_setting
user_preference


## Common Fields

required:

id uuid

created_at

updated_at

Prefer:

deleted_at

User related:

user_id

Status:

status


Avoid:

is_deleted


prefer:

- singular table

avoid:

- nullable abuse
- jsonb abuse