alter table public.corpus_items
add column analysis_detail jsonb;

alter table public.corpus_items
add constraint corpus_items_analysis_detail_object
check (analysis_detail is null or jsonb_typeof(analysis_detail) = 'object');
