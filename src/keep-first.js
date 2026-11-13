// Every row of the file is in the table now, next to any row with the same key
// that another run or an earlier import put there. The row with the lowest id
// for a key is the one that stays: ids only go up and every run looks after its
// own insert, so all runs agree on which one that is.
const { token } = $('Settings').first().json;
const first = new Map();
for (const { json: row } of $input.all()) {
  if (row.row_key === undefined) continue;
  const known = first.get(row.row_key);
  if (!known || row.id < known.id) first.set(row.row_key, row);
}
const added = [];
const remove = [];
const conflicts = [];
for (const { json: mine } of $('Claim rows').all()) {
  const winner = first.get(mine.row_key) ?? mine;
  if (winner.id === mine.id) {
    added.push(mine);
    continue;
  }
  remove.push(mine.id);
  // Same reading, other values: the stored row stays, and the phone is told.
  if (winner.content_hash !== mine.content_hash) {
    conflicts.push({
      device: mine.device,
      logged_at: mine.logged_at,
      entry_id: mine.entry_id,
      stored: { battery: winner.battery, temperature: winner.temperature, frame_drops: winner.frame_drops, note: winner.note },
      in_this_file: { battery: mine.battery, temperature: mine.temperature, frame_drops: mine.frame_drops, note: mine.note },
    });
  }
}
return [{ json: { token, added, remove, conflicts } }];
