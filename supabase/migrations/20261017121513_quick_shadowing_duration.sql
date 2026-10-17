-- Quick repeats allow twice the immutable source sentence duration. Keep the
-- legacy 61-second envelope and one second of recorder finalization tolerance.
alter table public.shadow_attempts
  drop constraint shadow_attempts_duration_ms_check,
  add constraint shadow_attempts_duration_ms_check check (
    duration_ms > 0
    and duration_ms <= greatest(61000::bigint, 2 * (end_ms - start_ms) + 1000)
  );
