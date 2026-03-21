-- HireMe database schema (PostgreSQL)
-- Covers: auth, experts, CV upload, booking, payment, consultation room/session.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ===== Enums =====
CREATE TYPE user_role AS ENUM ('candidate', 'expert', 'admin');
CREATE TYPE booking_status AS ENUM (
    'pending_payment',
    'confirmed',
    'in_room',
    'completed',
    'cancelled',
    'no_show'
);
CREATE TYPE payment_status AS ENUM ('initiated', 'paid', 'failed', 'refunded');
CREATE TYPE session_status AS ENUM ('waiting', 'live', 'ended');

-- ===== Users =====
CREATE TABLE users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL UNIQUE,
    full_name VARCHAR(120) NOT NULL,
    role user_role NOT NULL DEFAULT 'candidate',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_role ON users(role);

-- Keep public.users in sync with Supabase Auth.
CREATE OR REPLACE FUNCTION handle_new_auth_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.users (id, email, full_name)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1))
    )
    ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        full_name = COALESCE(public.users.full_name, EXCLUDED.full_name);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION handle_new_auth_user();

-- ===== Expert profile =====
CREATE TABLE expert_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(120) NOT NULL,
    bio TEXT,
    years_experience SMALLINT CHECK (years_experience >= 0),
    base_price_vnd INTEGER NOT NULL CHECK (base_price_vnd >= 0),
    avatar_url TEXT,
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    rating NUMERIC(3,2) NOT NULL DEFAULT 0.00 CHECK (rating >= 0 AND rating <= 5),
    total_reviews INTEGER NOT NULL DEFAULT 0 CHECK (total_reviews >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_expert_profiles_available ON expert_profiles(is_available);

-- ===== Candidate CV uploads =====
CREATE TABLE cv_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_filename VARCHAR(255) NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    mime_type VARCHAR(120) NOT NULL,
    file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes > 0),
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cv_files_candidate_uploaded_at ON cv_files(candidate_id, uploaded_at DESC);

-- ===== Booking slots (optional fixed slots like 09:00, 14:00, 20:00) =====
CREATE TABLE time_slots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT chk_slot_time CHECK (end_time > start_time),
    CONSTRAINT uq_time_slot UNIQUE(start_time, end_time)
);

-- ===== Bookings =====
CREATE TABLE bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    expert_id UUID REFERENCES expert_profiles(id) ON DELETE SET NULL,
    cv_file_id UUID NOT NULL REFERENCES cv_files(id) ON DELETE RESTRICT,
    slot_id UUID REFERENCES time_slots(id) ON DELETE SET NULL,
    booking_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    price_vnd INTEGER NOT NULL CHECK (price_vnd >= 0),
    status booking_status NOT NULL DEFAULT 'pending_payment',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_booking_time CHECK (end_time > start_time)
);

CREATE INDEX idx_bookings_candidate_date ON bookings(candidate_id, booking_date DESC, start_time DESC);
CREATE INDEX idx_bookings_expert_date ON bookings(expert_id, booking_date, start_time);
CREATE INDEX idx_bookings_status ON bookings(status);

-- Prevent double booking for an expert at the same date/time.
CREATE UNIQUE INDEX uq_expert_datetime
ON bookings(expert_id, booking_date, start_time)
WHERE status IN ('pending_payment', 'confirmed', 'in_room');

-- ===== Payments =====
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    amount_vnd INTEGER NOT NULL CHECK (amount_vnd >= 0),
    provider VARCHAR(50) NOT NULL DEFAULT 'bank_transfer_qr',
    provider_txn_id VARCHAR(120),
    status payment_status NOT NULL DEFAULT 'initiated',
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_created_at ON payments(created_at DESC);

-- ===== Consultation sessions (room) =====
CREATE TABLE consultation_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    room_code VARCHAR(40) NOT NULL UNIQUE,
    status session_status NOT NULL DEFAULT 'waiting',
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    recording_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_session_time CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);

-- ===== Session participant log =====
CREATE TABLE session_participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES consultation_sessions(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    left_at TIMESTAMPTZ,
    CONSTRAINT chk_join_leave CHECK (left_at IS NULL OR left_at >= joined_at),
    CONSTRAINT uq_session_user UNIQUE(session_id, user_id)
);

CREATE INDEX idx_session_participants_session ON session_participants(session_id);

-- ===== Review/rating (optional for future) =====
CREATE TABLE booking_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    candidate_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expert_id UUID NOT NULL REFERENCES expert_profiles(id) ON DELETE CASCADE,
    rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_booking_reviews_expert ON booking_reviews(expert_id, created_at DESC);

-- ===== Updated_at helper =====
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_expert_profiles_updated_at
BEFORE UPDATE ON expert_profiles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_bookings_updated_at
BEFORE UPDATE ON bookings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_payments_updated_at
BEFORE UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_consultation_sessions_updated_at
BEFORE UPDATE ON consultation_sessions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===== Supabase RLS =====
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE expert_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE cv_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE consultation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_select_authenticated" ON users
FOR SELECT TO authenticated
USING (TRUE);

CREATE POLICY "users_insert_own" ON users
FOR INSERT TO authenticated
WITH CHECK (id = auth.uid());

CREATE POLICY "users_update_own" ON users
FOR UPDATE TO authenticated
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

CREATE POLICY "experts_public_read" ON expert_profiles
FOR SELECT TO authenticated
USING (is_available = TRUE);

CREATE POLICY "cv_files_owner_read" ON cv_files
FOR SELECT TO authenticated
USING (candidate_id = auth.uid());

CREATE POLICY "cv_files_owner_insert" ON cv_files
FOR INSERT TO authenticated
WITH CHECK (candidate_id = auth.uid());

CREATE POLICY "bookings_owner_or_expert_read" ON bookings
FOR SELECT TO authenticated
USING (
    candidate_id = auth.uid()
    OR expert_id IN (SELECT ep.id FROM expert_profiles ep WHERE ep.user_id = auth.uid())
);

CREATE POLICY "bookings_owner_insert" ON bookings
FOR INSERT TO authenticated
WITH CHECK (candidate_id = auth.uid());

CREATE POLICY "bookings_owner_update" ON bookings
FOR UPDATE TO authenticated
USING (candidate_id = auth.uid())
WITH CHECK (candidate_id = auth.uid());

CREATE POLICY "payments_booking_owner_read" ON payments
FOR SELECT TO authenticated
USING (
    booking_id IN (
        SELECT b.id FROM bookings b WHERE b.candidate_id = auth.uid()
    )
);

CREATE POLICY "payments_booking_owner_insert" ON payments
FOR INSERT TO authenticated
WITH CHECK (
    booking_id IN (
        SELECT b.id FROM bookings b WHERE b.candidate_id = auth.uid()
    )
);

CREATE POLICY "session_owner_or_expert_read" ON consultation_sessions
FOR SELECT TO authenticated
USING (
    booking_id IN (
        SELECT b.id
        FROM bookings b
        LEFT JOIN expert_profiles ep ON ep.id = b.expert_id
        WHERE b.candidate_id = auth.uid() OR ep.user_id = auth.uid()
    )
);

CREATE POLICY "participants_owner_read" ON session_participants
FOR SELECT TO authenticated
USING (
    user_id = auth.uid()
    OR session_id IN (
        SELECT cs.id
        FROM consultation_sessions cs
        JOIN bookings b ON b.id = cs.booking_id
        LEFT JOIN expert_profiles ep ON ep.id = b.expert_id
        WHERE b.candidate_id = auth.uid() OR ep.user_id = auth.uid()
    )
);

CREATE POLICY "reviews_public_read" ON booking_reviews
FOR SELECT TO authenticated
USING (TRUE);

CREATE POLICY "reviews_candidate_insert" ON booking_reviews
FOR INSERT TO authenticated
WITH CHECK (candidate_id = auth.uid());

-- ===== Supabase Storage bucket & policies =====
INSERT INTO storage.buckets (id, name, public)
VALUES ('cv-files', 'cv-files', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "cv_storage_owner_read" ON storage.objects
FOR SELECT TO authenticated
USING (bucket_id = 'cv-files' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "cv_storage_owner_insert" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'cv-files' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "cv_storage_owner_update" ON storage.objects
FOR UPDATE TO authenticated
USING (bucket_id = 'cv-files' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'cv-files' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "cv_storage_owner_delete" ON storage.objects
FOR DELETE TO authenticated
USING (bucket_id = 'cv-files' AND (storage.foldername(name))[1] = auth.uid()::text);

COMMIT;

-- ===== Suggested seed data for current UI =====
-- INSERT INTO time_slots(start_time, end_time) VALUES
-- ('09:00', '09:45'),
-- ('14:00', '14:45'),
-- ('20:00', '20:45');
