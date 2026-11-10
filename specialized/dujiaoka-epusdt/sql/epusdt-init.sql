CREATE DATABASE IF NOT EXISTS epusdt CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'epusdt'@'%' IDENTIFIED BY '__MYSQL_PASSWORD__';
GRANT ALL PRIVILEGES ON epusdt.* TO 'epusdt'@'%';
FLUSH PRIVILEGES;
USE epusdt;

CREATE TABLE IF NOT EXISTS orders (
    id                   INT AUTO_INCREMENT PRIMARY KEY,
    trade_id             VARCHAR(32)    NOT NULL,
    order_id             VARCHAR(32)    NOT NULL,
    block_transaction_id VARCHAR(128)   NULL,
    actual_amount        DECIMAL(19, 4) NOT NULL,
    amount               DECIMAL(19, 4) NOT NULL,
    token                VARCHAR(50)    NOT NULL,
    status               INT DEFAULT 1  NOT NULL,
    notify_url           VARCHAR(128)   NOT NULL,
    redirect_url         VARCHAR(128)   NULL,
    callback_num         INT DEFAULT 0  NULL,
    callback_confirm     INT DEFAULT 2  NULL,
    created_at           TIMESTAMP      NULL,
    updated_at           TIMESTAMP      NULL,
    deleted_at           TIMESTAMP      NULL,
    CONSTRAINT orders_order_id_uindex UNIQUE (order_id),
    CONSTRAINT orders_trade_id_uindex UNIQUE (trade_id)
);

CREATE INDEX IF NOT EXISTS orders_block_transaction_id_index ON orders (block_transaction_id);

CREATE TABLE IF NOT EXISTS wallet_address (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    token      VARCHAR(50)   NOT NULL,
    status     INT DEFAULT 1 NOT NULL,
    created_at TIMESTAMP     NULL,
    updated_at TIMESTAMP     NULL,
    deleted_at TIMESTAMP     NULL
);

CREATE INDEX IF NOT EXISTS wallet_address_token_index ON wallet_address (token);
