-- Server-side token tracking so that logout truly invalidates tokens.
-- On login a row is inserted keyed by JWT jti; logout flips revoked_at.
CREATE TABLE IF NOT EXISTS auth_tokens (
    id BIGSERIAL PRIMARY KEY,
    jti UUID NOT NULL UNIQUE,
    subject_type VARCHAR(10) NOT NULL, -- 'user' | 'admin'
    subject_id BIGINT NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    ip_address VARCHAR(64),
    user_agent VARCHAR(500)
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_subject ON auth_tokens(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_jti ON auth_tokens(jti);
