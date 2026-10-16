-- Things a signed-in customer has hearted (hotels today; item_type leaves room
-- for tours / packages later). A snapshot of the card is kept so the dashboard
-- can list saved items without re-querying the supplier.
CREATE TABLE IF NOT EXISTS user_wishlist (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  item_type VARCHAR(30) NOT NULL,
  item_id VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  image_url VARCHAR(1000),
  location VARCHAR(255),
  stars DECIMAL(3,1),
  price DECIMAL(12,2),
  currency VARCHAR(8),
  meta JSON,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY wishlist_user_item (user_id, item_type, item_id),
  INDEX wishlist_user_recent (user_id, created_at)
);
