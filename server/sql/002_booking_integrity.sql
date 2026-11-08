-- Slotbook v2: relationships and immutable booking-session promises.
-- The host_id and event_type_id must refer to the SAME host, not just independently valid rows.
ALTER TABLE event_types ADD CONSTRAINT event_types_host_id_id_unique UNIQUE(host_id,id);
ALTER TABLE booking_sessions ADD CONSTRAINT booking_sessions_event_host_fk
  FOREIGN KEY(host_id,event_type_id) REFERENCES event_types(host_id,id);

-- A booking session describes a historical commitment. Moving the dates, buffers or capacity
-- via direct SQL would bypass booking locks and confuse existing guest reservations.
CREATE FUNCTION prevent_session_mutation() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.host_id, NEW.event_type_id, NEW.start_at, NEW.end_at,
       NEW.duration_minutes, NEW.capacity, NEW.buffer_before_minutes,
       NEW.buffer_after_minutes, NEW.occupied_range)
     IS DISTINCT FROM
     ROW(OLD.host_id, OLD.event_type_id, OLD.start_at, OLD.end_at,
       OLD.duration_minutes, OLD.capacity, OLD.buffer_before_minutes,
       OLD.buffer_after_minutes, OLD.occupied_range) THEN
    RAISE EXCEPTION 'Booking session schedule/capacity is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER booking_session_immutable BEFORE UPDATE ON booking_sessions
  FOR EACH ROW EXECUTE FUNCTION prevent_session_mutation();

CREATE FUNCTION prevent_event_host_move() RETURNS trigger AS $$
BEGIN
  IF NEW.host_id IS DISTINCT FROM OLD.host_id THEN
    RAISE EXCEPTION 'Event ownership cannot change' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER event_host_immutable BEFORE UPDATE ON event_types
  FOR EACH ROW EXECUTE FUNCTION prevent_event_host_move();

CREATE INDEX IF NOT EXISTS ix_bookings_hold_expiry ON bookings(hold_expires_at)
  WHERE status='held';
CREATE INDEX IF NOT EXISTS ix_auth_sessions_expiry ON auth_sessions(expires_at);
