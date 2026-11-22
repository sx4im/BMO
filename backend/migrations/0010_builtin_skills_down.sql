-- Removes account opt-ins. Reapplying the migration starts all built-ins disabled.
drop table if exists public.enabled_builtin_skills;
