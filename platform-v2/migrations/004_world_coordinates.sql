ALTER TABLE driver_presence
  ADD COLUMN world_x DECIMAL(16,3) NULL AFTER longitude,
  ADD COLUMN world_y DECIMAL(16,3) NULL AFTER world_x,
  ADD COLUMN world_z DECIMAL(16,3) NULL AFTER world_y,
  ADD KEY idx_presence_world_position (game, world_x, world_z, last_seen_at);
