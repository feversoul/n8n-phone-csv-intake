// The one answer the caller gets: an HTTP code and a JSON body.
const ran = (name) => $(name).isExecuted;
const out = (code, body) => [{ json: { code, body } }];

// GET: only the comparison.
if (!ran('Phone posts CSV')) {
  const comparison = $('Compare devices').first().json;
  return out(200, { ok: true, rows_stored: comparison.rows_stored, comparison: comparison.devices, summary: comparison.summary });
}

const file = $('Parse and check').first().json;
if (!file.ok) {
  const { code, ok, ...rest } = file;
  return out(code, { ok: false, ...rest });
}

const about = { file_hash: file.file_hash, form: file.form, delimiter: file.delimiter, header: file.header, rows_in_file: file.rows_in_file };

if (ran('Take the rows back')) {
  return out(502, {
    ok: false,
    error: 'sheet_append_failed',
    message: 'The rows could not be added to the Google Sheet, so they were taken out of the data table again. Nothing is half stored. Send the file again.',
    ...about,
  });
}

const comparison = $('Compare devices').first().json;
const duplicate = $('Seen this file?').first().json.duplicate_file;
const kept = duplicate ? { added: [], conflicts: [] } : $('Keep the first').first().json;
const usable = file.rows.length;
return out(200, {
  ok: true,
  ...about,
  duplicate_file: duplicate, // true: exactly this file was imported before, nothing was looked at again
  added: kept.added.length,
  already_stored: usable - kept.added.length,
  conflicts: kept.conflicts.slice(0, 20), // same reading as a stored row but other values: the stored row was kept
  conflict_count: kept.conflicts.length,
  rejected: file.rejected.slice(0, 20), // lines that were not stored, with the reason
  rejected_count: file.rejected.length,
  rows_stored: comparison.rows_stored,
  comparison: comparison.devices,
  summary: comparison.summary,
});
