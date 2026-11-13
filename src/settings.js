// Change these, then save. The other nodes of this workflow read them from here.
const SESSION_GAP_MINUTES = 30; // on one phone, a pause longer than this starts a new play session
const DAY_FIRST = true; // 03/04/2026 means 3 April. Set to false if your app writes month/day/year
const TEMP_MIN = -20; // a temperature outside this range is refused as a typing mistake
const TEMP_MAX = 100;
const MAX_ROWS = 2000; // a file with more rows than this is refused
// Used only for a file without a header row: what the columns mean, by how many there are.
const COLUMNS_WITHOUT_HEADER = {
  4: ['battery', 'temperature', 'frame_drops', 'note'],
  5: ['time', 'battery', 'temperature', 'frame_drops', 'note'],
  6: ['time', 'device', 'battery', 'temperature', 'frame_drops', 'note'],
};

const upload = $input.first();
return [
  {
    json: {
      session_gap_minutes: SESSION_GAP_MINUTES,
      day_first: DAY_FIRST,
      temp_min: TEMP_MIN,
      temp_max: TEMP_MAX,
      max_rows: MAX_ROWS,
      columns_without_header: COLUMNS_WITHOUT_HEADER,
      // One name per run: rows and the file record carry it, so a run can tell its own rows from another run's.
      token: `${$execution.id}-${Math.random().toString(36).slice(2, 10)}`,
      request: upload.json,
    },
    binary: upload.binary, // an uploaded file travels on to "Read the upload"
  },
];
