-- Server-authoritative payment orders.
--
-- Before this table the payment amount travelled to the gateway inside a hidden
-- form field rendered by the browser, so anyone could edit the DOM and pay a
-- different price. The order row is now created server-side BEFORE the customer
-- reaches the gateway, and the checkout form is built from this row - never from
-- request input. It also carries the full booking context, so the gateway
-- receipt can create the booking without trusting anything the gateway echoes
-- back beyond the decision and the reference.
CREATE TABLE IF NOT EXISTS payment_orders (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    order_reference VARCHAR(64) NOT NULL UNIQUE,
    transaction_uuid VARCHAR(64) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'created',
    gateway VARCHAR(40) NOT NULL DEFAULT 'cybersource',

    amount DECIMAL(12, 2) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'EUR',

    user_id BIGINT,
    booking_type VARCHAR(30) NOT NULL DEFAULT 'hotel',
    lead_first_name VARCHAR(120),
    lead_last_name VARCHAR(120),
    lead_email VARCHAR(190),
    lead_mobile VARCHAR(30),
    product_title VARCHAR(255),
    product_code VARCHAR(100),
    check_in_date DATE,
    check_out_date DATE,
    travel_date DATE,
    total_adults INT NOT NULL DEFAULT 1,
    total_children INT NOT NULL DEFAULT 0,
    is_refundable BOOLEAN NOT NULL DEFAULT TRUE,
    refund_window_hours INT NOT NULL DEFAULT 24,

    -- Travellers, offer id, search id, raw cart - everything the supplier-side
    -- reservation needs after the money clears.
    payload JSON,

    decision VARCHAR(20),
    gateway_reference VARCHAR(120),
    gateway_message TEXT,
    gateway_payload JSON,
    booking_id BIGINT,

    client_ip VARCHAR(64),
    expires_at DATETIME,
    paid_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_payment_orders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_payment_orders_booking FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL,
    INDEX idx_payment_orders_status (status),
    INDEX idx_payment_orders_email (lead_email),
    INDEX idx_payment_orders_created (created_at)
);
