// Was exactly this file imported before? Only an import that finished counts:
// a run that failed half way must not block the next try. Two copies arriving
// at the same moment both get past this check; the row keys stop them later.
const token = $('Settings').first().json.token;
const earlier = $input
  .all()
  .map((item) => item.json)
  .filter((row) => row.token !== token && row.status === 'done')
  .sort((a, b) => a.id - b.id);
return [{ json: { duplicate_file: earlier.length > 0, first_imported_at: earlier[0]?.received_at ?? null } }];
