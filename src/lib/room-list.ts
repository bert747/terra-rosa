// ---------------------------------------------------------------------------
// The real Terra Rosa room list, transcribed from the occupancy spreadsheet
// ("טרה רוסה - תפוסה"). This replaces the 20 generic "Room 1..20" placeholders
// the project was scaffolded with.
//
// WHAT THE SPREADSHEET DOES AND DOESN'T GIVE US
//
// Room NAMES are taken directly from the sheet's row labels, grouped under its
// own section headers (1st Floor, Floor 2, Monks, Outside, Guardians):
//
//   1st Floor : Ensuite 1, Sea 1, Courtyard 1, Back Room
//   Floor 2   : Ensuite 2, Sea 2, Courtyard 2, Dorm 2
//   Monks     : Monk 1 .. Monk 7
//   Outside   : Bunker (its two beds are labelled "Close" and "Far"),
//               Van / Caravan, Infirmary, Ashram Room, Camping
//
// BED COUNTS COME FROM THE SHEET'S ROW LAYOUT. There's no bed-count column,
// but there doesn't need to be: each room's label is a merged cell spanning as
// many rows as the room has occupant lines, and those lines get used
// concurrently (Monk 1, for instance, has four rows and shows Julian, Sami and
// Roel side by side in December). So rows-per-room is the bed count.
//
// The numbers below were read off the PDF export of the sheet geometrically —
// measuring each merged label block's height against the 1.575pt row pitch —
// and then cross-checked against the text: for every room, the number of
// distinct occupant lines actually used across the whole sheet equals the
// number of rows in its block. The Bunker is the one room whose beds are named
// individually ("Close" and "Far", two rows each, so four beds).
//
// Camping is one labelled row in the sheet; extra tents get written into the
// unbordered space below it, so treat its count as nominal and use a capacity
// override when a gathering fills the field.
//
// The Guardians / Residents / Workers rooms are not in the sheet's row layout
// as named rooms — its staff block has seven rows shared between them — so they
// stay at one bed each, matching the eleven people named on its "Permanent"
// tab (guardians Rosa, Nils, Hagai, Ofer, Tamir; residents Tim, JM, Roy;
// workers Yaya, Lucero, Gabriel).
//
// Applying these to a live database: `npm run rooms:reset-beds`.
//
// The Guardians / Residents / Workers rows exist in the spreadsheet as
// permanent-staff accommodation but aren't given room names there, so they're
// modelled here as numbered rooms per role, with the current occupant recorded
// in `notes` (taken from the sheet's "Permanent" summary tab: guardians Rosa,
// Nils, Hagai, Ofer and Tamir; residents Tim, JM and Roy; workers Yaya, Lucero
// and Gabriel). Rename them if the house has better names for these spaces.
// ---------------------------------------------------------------------------

export interface RoomSeed {
  name: string;
  locationOrType: string;
  defaultBedCount: number;
  notes?: string;
}

export const TERRA_ROSA_ROOMS: RoomSeed[] = [
  // --- 1st Floor ---------------------------------------------------------
  { name: "Ensuite 1", locationOrType: "1st Floor", defaultBedCount: 4 },
  { name: "Sea 1", locationOrType: "1st Floor", defaultBedCount: 5 },
  { name: "Courtyard 1", locationOrType: "1st Floor", defaultBedCount: 5 },
  { name: "Back Room", locationOrType: "1st Floor", defaultBedCount: 2 },

  // --- Floor 2 -----------------------------------------------------------
  { name: "Ensuite 2", locationOrType: "Floor 2", defaultBedCount: 2 },
  { name: "Sea 2", locationOrType: "Floor 2", defaultBedCount: 4 },
  { name: "Courtyard 2", locationOrType: "Floor 2", defaultBedCount: 5 },
  { name: "Dorm 2", locationOrType: "Floor 2", defaultBedCount: 6 },

  // --- Monks -------------------------------------------------------------
  { name: "Monk 1", locationOrType: "Monks", defaultBedCount: 4 },
  { name: "Monk 2", locationOrType: "Monks", defaultBedCount: 2 },
  { name: "Monk 3", locationOrType: "Monks", defaultBedCount: 3 },
  { name: "Monk 4", locationOrType: "Monks", defaultBedCount: 3 },
  { name: "Monk 5", locationOrType: "Monks", defaultBedCount: 3 },
  { name: "Monk 6", locationOrType: "Monks", defaultBedCount: 3 },
  { name: "Monk 7", locationOrType: "Monks", defaultBedCount: 3 },

  // --- Outside -----------------------------------------------------------
  { name: "Bunker", locationOrType: "Outside", defaultBedCount: 4, notes: "Two beds each under the sheet's 'Close' and 'Far' labels" },
  { name: "Van / Caravan", locationOrType: "Outside", defaultBedCount: 4 },
  { name: "Infirmary", locationOrType: "Outside", defaultBedCount: 4 },
  { name: "Ashram Room", locationOrType: "Outside", defaultBedCount: 6 },
  {
    name: "Camping",
    locationOrType: "Outside",
    defaultBedCount: 1,
    notes:
      "One row in the spreadsheet; extra tents are written in below it. Capacity here is seasonal — use a capacity override rather than editing the default when it changes for an event.",
  },

  // --- Permanent staff ---------------------------------------------------
  { name: "Guardian 1", locationOrType: "Guardians", defaultBedCount: 1, notes: "Spreadsheet lists guardian: Rosa" },
  { name: "Guardian 2", locationOrType: "Guardians", defaultBedCount: 1, notes: "Spreadsheet lists guardian: Nils" },
  { name: "Guardian 3", locationOrType: "Guardians", defaultBedCount: 1, notes: "Spreadsheet lists guardian: Hagai" },
  { name: "Guardian 4", locationOrType: "Guardians", defaultBedCount: 1, notes: "Spreadsheet lists guardian: Ofer" },
  { name: "Guardian 5", locationOrType: "Guardians", defaultBedCount: 1, notes: "Spreadsheet lists guardian: Tamir" },

  { name: "Resident 1", locationOrType: "Residents", defaultBedCount: 1, notes: "Spreadsheet lists resident: Tim" },
  { name: "Resident 2", locationOrType: "Residents", defaultBedCount: 1, notes: "Spreadsheet lists resident: JM (Jean Marc)" },
  { name: "Resident 3", locationOrType: "Residents", defaultBedCount: 1, notes: "Spreadsheet lists resident: Roy" },

  { name: "Worker 1", locationOrType: "Workers", defaultBedCount: 1, notes: "Spreadsheet lists worker: Yaya" },
  { name: "Worker 2", locationOrType: "Workers", defaultBedCount: 1, notes: "Spreadsheet lists worker: Lucero" },
  { name: "Worker 3", locationOrType: "Workers", defaultBedCount: 1, notes: "Spreadsheet lists worker: Gabriel" },
];
