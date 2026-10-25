-- docker-compose.dev.yml only: owner role + database for local development. Dev password; never reuse.
CREATE ROLE hrm_app LOGIN PASSWORD 'hrm_app_dev' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE hrm_dev OWNER hrm_app;
