// Turns the uploaded text into checked rows, or into a clear answer for the
// phone when the file cannot be used. Nothing is written here.

__SHA256__

const settings = $('Settings').first().json;
const upload = $input.first().json;

const refuse = (code, error, message, extra = {}) => [{ json: { ok: false, code, error, message, form: upload.form, ...extra } }];

if (upload.form === 'none' || upload.text.trim() === '') {
  return refuse(
    400,
    'no_csv',
    'No CSV text arrived. Send the file as a form upload, or its text as the request body with Content-Type: text/csv, or JSON like {"csv": "..."}.',
  );
}

// Same text, same hash: line endings and a missing last line break do not make a file "new".
const text = upload.text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
const file_hash = sha256(text);

// --- split into records ------------------------------------------------------
// A field that starts with " runs to the closing ", and may hold the separator,
// line breaks and "" for a quote. Returns the records with the line each starts on.
function split(source, separator) {
  const records = [];
  let fields = [];
  let field = '';
  let quoted = false;
  let fieldStart = true;
  let line = 1;
  let startLine = 1;
  const endField = () => {
    fields.push(field);
    field = '';
    fieldStart = true;
  };
  const endRecord = () => {
    endField();
    if (fields.length > 1 || fields[0].trim() !== '') records.push({ line: startLine, fields });
    fields = [];
    startLine = line + 1;
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else {
        if (char === '\n') line++;
        field += char;
      }
    } else if (char === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
    } else if (char === separator) endField();
    else if (char === '\n') {
      endRecord();
      line++;
    } else {
      field += char;
      fieldStart = false;
    }
  }
  const openQuote = quoted;
  if (field !== '' || fields.length > 0 || openQuote) endRecord();
  return { records, openQuote };
}

// --- find the separator ------------------------------------------------------
// The first record decides how many columns there are; the separator that
// gives the most records with that many columns wins. One column never counts.
const NAMES = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' };
let body = text;
let candidates = Object.keys(NAMES);
const hint = /^sep=(.)\n/i.exec(text); // a first line "sep=;" as Excel writes it
if (hint) {
  body = text.slice(hint[0].length);
  candidates = [hint[1]];
}
let best = null;
for (const separator of candidates) {
  const parsed = split(body, separator);
  const columns = parsed.records[0]?.fields.length ?? 0;
  if (columns < 2) continue;
  const score = parsed.records.filter((record) => record.fields.length === columns).length * columns;
  if (!best || score > best.score) best = { separator, columns, score, ...parsed };
}
const firstLine = body.split('\n')[0].slice(0, 120);
if (!best) {
  return refuse(
    422,
    'one_column',
    'The file has only one column per line, so nothing was stored. I looked for a comma, semicolon, tab or | between the values and found none in the first line. Check what the export writes between values.',
    { file_hash, first_line: firstLine },
  );
}
if (best.openQuote) {
  return refuse(
    422,
    'cut_off',
    'The file ends inside a quoted field, so it looks cut off. Nothing was stored. Send it again when the export is complete.',
    { file_hash, delimiter: NAMES[best.separator] },
  );
}

// --- which column is what ----------------------------------------------------
const fieldOf = (heading) => {
  const name = heading.toLowerCase().replace(/[^a-z0-9%°]/g, '');
  if (name === '') return null;
  if (/temp|°/.test(name)) return 'temperature';
  if (/drop|frame|jank|stutter/.test(name)) return 'frame_drops';
  if (/batt|charge|^bat%?$/.test(name)) return 'battery';
  if (/note|comment|remark|descr|what/.test(name)) return 'note';
  if (/session|^run$/.test(name)) return 'session';
  if (/device|phone|model/.test(name)) return 'device';
  if (/^(id|logid|entryid|rowid|uid|uuid)$/.test(name)) return 'entry_id';
  if (/^date$|^day$/.test(name)) return 'date';
  if (/time|when|logged|date/.test(name)) return 'time';
  return null;
};
const looksLikeNumber = (value) => /^[-+]?\d+([.,]\d+)?\s*(%|°?c)?$/i.test(value.trim());

const first = best.records[0].fields;
const guessed = first.map(fieldOf);
const header = guessed.some(Boolean) && !first.some(looksLikeNumber);
let columns;
let records;
if (header) {
  columns = guessed;
  records = best.records.slice(1);
} else {
  columns = settings.columns_without_header[String(first.length)];
  records = best.records;
  if (!columns) {
    return refuse(
      422,
      'no_header',
      `The file has no header row and ${first.length} columns. Without a header I can read ${Object.keys(settings.columns_without_header).join(', ')} columns (see Settings), or add a header row: time, device, battery, temperature, frame drops, note.`,
      { file_hash, delimiter: NAMES[best.separator], first_line: firstLine },
    );
  }
}
const at = (field) => columns.indexOf(field);
const missing = ['battery', 'temperature', 'frame_drops', 'note'].filter((field) => at(field) < 0);
if (missing.length > 0) {
  return refuse(422, 'missing_columns', `I cannot find a column for: ${missing.join(', ')}. The header I read is: ${first.join(' | ')}.`, {
    file_hash,
    delimiter: NAMES[best.separator],
    missing,
  });
}
if (at('device') < 0 && upload.device === '') {
  return refuse(
    422,
    'no_device',
    'I do not know which phone this log is from. Add ?device=NAME to the address the shortcut posts to, or a device column to the file.',
    { file_hash, delimiter: NAMES[best.separator] },
  );
}
if (records.length > settings.max_rows) {
  return refuse(413, 'too_many_rows', `The file has ${records.length} rows; the limit is ${settings.max_rows} (MAX_ROWS in Settings).`, { file_hash });
}

// --- read the values ---------------------------------------------------------
// "85%", "38,5", "38.5 °C" -> number. null when it is not a number.
const number = (value) => {
  const cleaned = value
    .trim()
    .replace(/\s*(%|°\s*c|°|c)$/i, '')
    .replace(',', '.');
  return /^[-+]?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
};

// A time as written on the phone -> "2026-10-28T14:05:00", without a time zone:
// the comparison only needs the distance between two readings of one phone.
const two = (n) => String(n).padStart(2, '0');
function time(value) {
  const raw = value.trim();
  if (raw === '') return '';
  let parts = null;
  let m;
  if (/^\d{10}$|^\d{13}$/.test(raw)) {
    const date = new Date(Number(raw) * (raw.length === 10 ? 1000 : 1));
    parts = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()];
  } else if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(am|pm)?)?\s*(?:z|[+-]\d{2}:?\d{2})?$/i.exec(raw))) {
    parts = [m[1], m[2], m[3], m[4] ?? 0, m[5] ?? 0, m[6] ?? 0, m[7]];
  } else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(raw))) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    parts = settings.day_first ? [year, m[2], m[1]] : [year, m[1], m[2]];
    parts.push(m[4] ?? 0, m[5] ?? 0, m[6] ?? 0, m[7]);
  }
  if (!parts) return null;
  let [year, month, day, hour, minute, second] = parts.slice(0, 6).map(Number);
  const half = String(parts[6] ?? '').toLowerCase();
  if (half === 'pm' && hour < 12) hour += 12;
  if (half === 'am' && hour === 12) hour = 0;
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const real = check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day && hour < 24 && minute < 60 && second < 60;
  return real ? `${year}-${two(month)}-${two(day)}T${two(hour)}:${two(minute)}:${two(second)}` : null;
}

const rows = [];
const rejected = [];
const seen = new Map();
let repeated = 0;
const cutOffHint = (record) => (record === records[records.length - 1] ? ' It is the last line: the file may be cut off, send it again when the export is complete.' : '');

for (const record of records) {
  const reject = (reason) => rejected.push({ line: record.line, reason });
  if (record.fields.length !== columns.length) {
    reject(`has ${record.fields.length} of ${columns.length} columns.${cutOffHint(record)}`);
    continue;
  }
  const cell = (field) => (at(field) < 0 ? '' : record.fields[at(field)].trim());

  const device = cell('device') || upload.device;
  if (device === '') {
    reject('no device');
    continue;
  }
  const battery = number(cell('battery'));
  if (battery === null || battery < 0 || battery > 100) {
    reject(`battery "${cell('battery')}" is not a number from 0 to 100`);
    continue;
  }
  const temperature = number(cell('temperature'));
  if (temperature === null || temperature < settings.temp_min || temperature > settings.temp_max) {
    reject(`temperature "${cell('temperature')}" is not a number from ${settings.temp_min} to ${settings.temp_max}`);
    continue;
  }
  const frame_drops = number(cell('frame_drops'));
  if (frame_drops === null || frame_drops < 0 || !Number.isInteger(frame_drops)) {
    reject(`frame drops "${cell('frame_drops')}" is not a whole number of 0 or more`);
    continue;
  }
  const written = at('date') >= 0 ? `${cell('date')} ${cell('time')}`.trim() : cell('time');
  const logged_at = time(written);
  if (logged_at === null) {
    reject(`time "${written}" is not a date and time I can read`);
    continue;
  }
  const note = cell('note').replace(/\r/g, '');
  const session = cell('session');
  const entry_id = cell('entry_id');

  // What makes two rows "the same reading": the app's own id when there is one,
  // else phone + time, else the whole row.
  const identity = entry_id !== '' ? ['id', device, entry_id] : logged_at !== '' ? ['time', device, logged_at] : ['row', device, battery, temperature, frame_drops, note];
  const row_key = sha256(identity.join('\u001f')).slice(0, 32);
  const content_hash = sha256([device, logged_at, battery, temperature, frame_drops, note, session].join('\u001f')).slice(0, 16);

  if (seen.has(row_key)) {
    if (seen.get(row_key) === content_hash) repeated++;
    else reject('same phone and time (or id) as an earlier line of this file, with different values. The earlier line was kept.');
    continue;
  }
  seen.set(row_key, content_hash);
  rows.push({ row_key, content_hash, line: record.line, device, logged_at, session, battery, temperature, frame_drops, note, entry_id });
}

if (rows.length === 0) {
  return refuse(422, 'no_rows', records.length === 0 ? 'The file has a header but no rows.' : `None of the ${records.length} rows could be used. See "rejected" for the reason per line.`, {
    file_hash,
    delimiter: NAMES[best.separator],
    rejected: rejected.slice(0, 20),
    rejected_count: rejected.length,
  });
}

return [
  {
    json: {
      ok: true,
      form: upload.form,
      filename: upload.filename,
      device: upload.device,
      file_hash,
      delimiter: NAMES[best.separator],
      header,
      rows_in_file: records.length,
      repeated_in_file: repeated,
      rows,
      rejected,
    },
  },
];
