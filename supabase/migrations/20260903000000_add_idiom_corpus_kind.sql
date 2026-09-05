alter table public.corpus_items
drop constraint corpus_items_kind_valid;

alter table public.corpus_items
add constraint corpus_items_kind_valid
check (kind in ('chunk', 'idiom', 'structure'));
