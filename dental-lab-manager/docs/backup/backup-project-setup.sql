-- Run ONCE in the SQL editor of the SEPARATE backup project (not the app project).
-- Creates a private bucket that the backup uploader can only ADD files to:
-- no listing, no download, no overwrite, no delete with the uploader's key.
-- Files are read only by the project owner (dashboard / service key).
insert into storage.buckets (id, name, public, file_size_limit)
values ('dlm-backups', 'dlm-backups', false, 104857600)
on conflict (id) do nothing;

create policy dlm_backups_insert_only on storage.objects for insert to anon
  with check (
    bucket_id = 'dlm-backups'
    and name ~ '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\.json\.age$'
  );
-- deliberately NO select / update / delete policy for anon or authenticated
