-- Allow phone-recorded order evidence videos to upload into the existing
-- private order evidence bucket. iPhone .mov files frequently exceed 50 MiB.

update storage.buckets
set file_size_limit = 524288000
where id = 'order-evidence-photos';

