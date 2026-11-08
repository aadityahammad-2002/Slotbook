-- Slotbook v1: database invariants for one-on-one and capacity-limited group events.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp());

CREATE TABLE IF NOT EXISTS hosts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), slug TEXT NOT NULL UNIQUE,
 display_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
 time_zone TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS auth_sessions (
 token_hash TEXT PRIMARY KEY, host_id UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
 expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS event_types (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), host_id UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
 slug TEXT NOT NULL, name TEXT NOT NULL,
 duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 15 AND 120),
 capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 50),
 buffer_before_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_before_minutes BETWEEN 0 AND 30),
 buffer_after_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_after_minutes BETWEEN 0 AND 30),
 minimum_notice_minutes INTEGER NOT NULL DEFAULT 240 CHECK (minimum_notice_minutes BETWEEN 0 AND 43200),
 booking_horizon_days INTEGER NOT NULL DEFAULT 30 CHECK (booking_horizon_days BETWEEN 1 AND 365),
 is_active BOOLEAN NOT NULL DEFAULT TRUE,
 UNIQUE(host_id,slug)
);
CREATE TABLE IF NOT EXISTS weekly_availability (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 host_id UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
 weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
 start_min INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
 end_min INTEGER NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
 CHECK (start_min < end_min), UNIQUE(host_id,weekday,start_min,end_min)
);
CREATE TABLE IF NOT EXISTS date_overrides (
 host_id UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
 local_date DATE NOT NULL,
 is_closed BOOLEAN NOT NULL DEFAULT FALSE,
 windows JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(windows)='array'),
 PRIMARY KEY(host_id,local_date)
);
CREATE TABLE IF NOT EXISTS booking_sessions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), host_id UUID NOT NULL REFERENCES hosts(id),
 event_type_id UUID NOT NULL REFERENCES event_types(id),
 start_at TIMESTAMPTZ NOT NULL, end_at TIMESTAMPTZ NOT NULL,
 duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 15 AND 120),
 capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 50),
 buffer_before_minutes INTEGER NOT NULL CHECK (buffer_before_minutes BETWEEN 0 AND 30),
 buffer_after_minutes INTEGER NOT NULL CHECK (buffer_after_minutes BETWEEN 0 AND 30),
 occupied_range TSTZRANGE NOT NULL,
 state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','released')),
 CHECK(end_at > start_at),
 CHECK(end_at - start_at = duration_minutes * INTERVAL '1 minute'),
 CHECK(NOT isempty(occupied_range) AND NOT lower_inf(occupied_range) AND NOT upper_inf(occupied_range)),
 CHECK(lower_inc(occupied_range) AND NOT upper_inc(occupied_range)),
 CHECK(lower(occupied_range) = start_at - buffer_before_minutes * INTERVAL '1 minute'),
 CHECK(upper(occupied_range) = end_at + buffer_after_minutes * INTERVAL '1 minute'),
 CONSTRAINT no_host_session_overlap EXCLUDE USING gist (host_id WITH =, occupied_range WITH &&) WHERE (state='active')
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_session_per_event_time ON booking_sessions(event_type_id,start_at) WHERE state='active';
CREATE INDEX IF NOT EXISTS ix_sessions_host_time ON booking_sessions(host_id,start_at);
CREATE TABLE IF NOT EXISTS session_seats (
 session_id UUID NOT NULL REFERENCES booking_sessions(id), seat_no INTEGER NOT NULL CHECK (seat_no > 0),
 PRIMARY KEY(session_id,seat_no)
);
CREATE TABLE IF NOT EXISTS bookings (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 session_id UUID NOT NULL, seat_no INTEGER NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','confirmed','expired','cancelled')),
 hold_expires_at TIMESTAMPTZ NOT NULL,
 guest_name TEXT, guest_email TEXT,
 version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
 cancel_reason TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(session_id,seat_no) REFERENCES session_seats(session_id,seat_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking_per_seat ON bookings(session_id,seat_no) WHERE status IN ('held','confirmed');
CREATE INDEX IF NOT EXISTS ix_bookings_session_status ON bookings(session_id,status);
CREATE TABLE IF NOT EXISTS idempotency_records (
 scope TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL,
 http_status INTEGER, response_json JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(scope,key)
);
CREATE TABLE IF NOT EXISTS notification_outbox (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 booking_id UUID NOT NULL REFERENCES bookings(id), event_type TEXT NOT NULL,
 payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- A direct SQL writer cannot create seats beyond the session's capacity.
CREATE OR REPLACE FUNCTION enforce_seat_capacity() RETURNS TRIGGER AS $$
DECLARE max_seats INTEGER;
BEGIN
 SELECT capacity INTO max_seats FROM booking_sessions WHERE id=NEW.session_id;
 IF max_seats IS NULL OR NEW.seat_no > max_seats THEN
   RAISE EXCEPTION 'Seat exceeds session capacity' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS seat_capacity_guard ON session_seats;
CREATE TRIGGER seat_capacity_guard BEFORE INSERT OR UPDATE ON session_seats
FOR EACH ROW EXECUTE FUNCTION enforce_seat_capacity();

-- These deferred checks validate the final transaction state, permitting an
-- atomic reschedule to release an old session before moving its last booking.
CREATE OR REPLACE FUNCTION check_session_release_consistency() RETURNS TRIGGER AS $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM booking_sessions s JOIN bookings b ON b.session_id=s.id
  WHERE s.id=NEW.id AND s.state='released' AND b.status IN ('held','confirmed')
 ) THEN
  RAISE EXCEPTION 'Released session has active bookings' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS release_guard ON booking_sessions;
CREATE CONSTRAINT TRIGGER release_guard AFTER INSERT OR UPDATE ON booking_sessions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_session_release_consistency();
CREATE OR REPLACE FUNCTION check_active_booking_session() RETURNS TRIGGER AS $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM bookings b JOIN booking_sessions s ON s.id=b.session_id
  WHERE b.id=NEW.id AND b.status IN ('held','confirmed') AND s.state<>'active'
 ) THEN
  RAISE EXCEPTION 'Active booking references released session' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS active_booking_guard ON bookings;
CREATE CONSTRAINT TRIGGER active_booking_guard AFTER INSERT OR UPDATE ON bookings
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_active_booking_session();
