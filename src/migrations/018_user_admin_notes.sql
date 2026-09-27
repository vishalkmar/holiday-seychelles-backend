-- Internal notes an operator can leave on a customer.
-- Never shown to the customer; visible only in the admin panel.
ALTER TABLE users ADD COLUMN admin_notes TEXT;
