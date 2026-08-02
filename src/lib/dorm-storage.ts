// "Dorm Storage" is a system room (see rooms.excludeFromCapacity in
// src/db/schema.ts) that beds can be parked in without counting toward house
// capacity. These names are shared between the server-side get-or-create
// logic (ensureDormStorageRoomId in src/lib/grid-data.ts) and any client
// code that needs to recognise the reserved floor — kept in their own file,
// with no imports, so client components can use them without pulling in
// server-only DB code.
export const DORM_STORAGE_FLOOR_NAME = "Storage";
export const DORM_STORAGE_ROOM_NAME = "Dorm Storage";
