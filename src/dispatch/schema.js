import {db} from "../database/mysql.js";

export async function ensureDispatchSchema(){
  await db().query(`CREATE TABLE IF NOT EXISTS work_assignments(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    work_code VARCHAR(30) UNIQUE,
    driver_id BIGINT UNSIGNED NOT NULL,
    cargo VARCHAR(150) NOT NULL,
    origin_city VARCHAR(150) NOT NULL,
    destination_city VARCHAR(150) NOT NULL,
    min_miles DECIMAL(10,2) NOT NULL DEFAULT 0,
    deadline_at DATETIME NULL,
    notes VARCHAR(1000),
    status VARCHAR(50) NOT NULL DEFAULT 'assigned',
    created_by VARCHAR(32) NOT NULL,
    assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP NULL,
    completed_at TIMESTAMP NULL,
    tracker_verified TINYINT(1) NOT NULL DEFAULT 0,
    actual_cargo VARCHAR(150),
    actual_origin_city VARCHAR(150),
    actual_destination_city VARCHAR(150),
    actual_distance_miles DECIMAL(12,2) NOT NULL DEFAULT 0,
    actual_damage DECIMAL(8,5) NOT NULL DEFAULT 0,
    actual_revenue DECIMAL(16,2) NOT NULL DEFAULT 0,
    verification_notes VARCHAR(1000),
    INDEX(driver_id,status),INDEX(status,deadline_at),INDEX(assigned_at)
  )`);
}
