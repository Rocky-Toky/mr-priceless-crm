-- Space to store a client's main point-of-contact phone number and email,
-- separate from client-report-email (which is specifically where automated
-- ad reports get sent, and may be a different inbox e.g. an ops alias).
alter table clients add column if not exists phone text;
alter table clients add column if not exists email text;
