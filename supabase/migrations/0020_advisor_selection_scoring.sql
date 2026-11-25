begin;

create or replace function public.quorum_select_advisors_for_question(
  p_query_embedding text,
  p_min_score numeric default 0.30,
  p_limit integer default 5
)
returns table (
  advisor_id uuid,
  display_name text,
  display_name_key text,
  specialist_fit_score numeric,
  topic_tag_score numeric,
  dossier_theme_score numeric,
  source_coverage_score numeric,
  matched_topic_tag_keys text[],
  matched_fragment_ids uuid[]
)
language sql
stable
as $$
  with candidates as (
    select
      advisor.id,
      advisor.display_name,
      advisor.display_name_key::text as display_name_key,
      profile.embedding as profile_embedding
    from public.advisors as advisor
    join public.advisor_selection_profiles as profile
      on profile.advisor_id = advisor.id
    join public.advisor_dossiers as dossier
      on dossier.advisor_id = advisor.id
     and dossier.id = profile.dossier_id
     and dossier.artifact_state = 'approved'
     and dossier.is_current = true
    where advisor.persona_status = 'active'
      and advisor.readiness_status = 'advisor_ready'
      and advisor.benchmark_passed_at is not null
      and advisor.is_launch_enabled = true
      and exists (
        select 1
        from public.advisor_topic_tags as tag
        where tag.advisor_id = advisor.id
          and tag.tag_state = 'approved'
      )
  ),
  scored as (
    select
      candidate.id as advisor_id,
      candidate.display_name,
      candidate.display_name_key,
      round(greatest(tag.topic_tag_score, profile.dossier_theme_score, source.source_coverage_score)::numeric, 5) as specialist_fit_score,
      round(tag.topic_tag_score::numeric, 5) as topic_tag_score,
      round(profile.dossier_theme_score::numeric, 5) as dossier_theme_score,
      round(source.source_coverage_score::numeric, 5) as source_coverage_score,
      tag.matched_topic_tag_keys,
      source.matched_fragment_ids
    from candidates as candidate
    cross join lateral (
      select greatest(
        0::double precision,
        least(1::double precision, 1 - (candidate.profile_embedding <=> (p_query_embedding::vector)))
      ) as dossier_theme_score
    ) as profile
    cross join lateral (
      select
        coalesce(max(match.score), 0::double precision) as topic_tag_score,
        coalesce((array_agg(match.tag_key order by match.score desc, match.tag_key))[1:5], array[]::text[]) as matched_topic_tag_keys
      from (
        select
          tag.tag_key::text,
          greatest(
            0::double precision,
            least(1::double precision, 1 - (tag.embedding <=> (p_query_embedding::vector)))
          ) as score
        from public.advisor_topic_tags as tag
        where tag.advisor_id = candidate.id
          and tag.tag_state = 'approved'
      ) as match
    ) as tag
    cross join lateral (
      select
        coalesce(max(match.score), 0::double precision) as source_coverage_score,
        coalesce((array_agg(match.fragment_id order by match.score desc, match.fragment_id))[1:5], array[]::uuid[]) as matched_fragment_ids
      from (
        select
          fragment.id as fragment_id,
          greatest(
            0::double precision,
            least(1::double precision, 1 - (fragment.embedding <=> (p_query_embedding::vector)))
          ) as score
        from public.corpus_fragments as fragment
        join public.corpus_documents as document
          on document.id = fragment.document_id
         and document.advisor_id = fragment.advisor_id
        join public.advisor_sources as source
          on source.id = document.source_id
         and source.advisor_id = document.advisor_id
        where fragment.advisor_id = candidate.id
          and fragment.fragment_state = 'approved'
          and document.document_state = 'approved'
          and source.acquisition_status in ('approved', 'ingested')
        order by score desc, fragment.id
        limit 5
      ) as match
    ) as source
  )
  select
    scored.advisor_id,
    scored.display_name,
    scored.display_name_key,
    scored.specialist_fit_score,
    scored.topic_tag_score,
    scored.dossier_theme_score,
    scored.source_coverage_score,
    scored.matched_topic_tag_keys,
    scored.matched_fragment_ids
  from scored
  where scored.specialist_fit_score >= greatest(0::numeric, least(1::numeric, coalesce(p_min_score, 0.30)))
  order by
    scored.specialist_fit_score desc,
    scored.topic_tag_score desc,
    scored.source_coverage_score desc,
    scored.display_name_key asc
  limit greatest(1, least(coalesce(p_limit, 5), 5));
$$;

grant execute on function public.quorum_select_advisors_for_question(text, numeric, integer) to service_role;

commit;
