-- docker-compose.dev.yml only: password for the hrm_runtime role created by db/runtime-role.sql. Dev only.
ALTER ROLE hrm_runtime PASSWORD 'hrm_runtime_dev';
