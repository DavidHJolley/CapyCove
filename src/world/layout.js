/**
 * Layout overrides for the dev editor (Ctrl+E).
 *
 * A room is built from numbers, and everything a prop owns (its sign, chairs,
 * prompt zones, obstacle circles, glow rings) is derived from those numbers at
 * build time. Most of that derived scenery is merged into shared instanced
 * batches with no individual object to drag, so the editor does not move
 * geometry: it edits the numbers here and asks the engine to rebuild the room.
 * The rebuild is the same code path as walking in, so the result is exactly
 * what you get after pasting the values into the room file.
 *
 * Session-only by design: nothing here persists across a reload. Copy the
 * numbers out of the editor and paste them into the room file, which stays the
 * single source of truth.
 */

const overrides = new Map(); // `${roomId}` -> Map(propId -> patch object)

export function getOverrides(roomId) {
  return overrides.get(roomId) || null;
}

export function getOverride(roomId, propId) {
  return overrides.get(roomId)?.get(propId) || null;
}

export function setOverride(roomId, propId, patch) {
  if (!overrides.has(roomId)) overrides.set(roomId, new Map());
  const room = overrides.get(roomId);
  room.set(propId, { ...(room.get(propId) || {}), ...patch });
}

export function clearOverrides(roomId) {
  if (roomId) overrides.delete(roomId);
  else overrides.clear();
}

export function hasOverrides(roomId) {
  return (overrides.get(roomId)?.size || 0) > 0;
}
