# n8n phone CSV intake

[![test](https://github.com/feversoul/n8n-phone-csv-intake/actions/workflows/test.yml/badge.svg)](https://github.com/feversoul/n8n-phone-csv-intake/actions/workflows/test.yml)

You keep a small log on your phone while testing games: battery, device temperature, frame drops, a note. An app exports it as CSV. This n8n workflow takes that CSV straight from a shortcut on the phone, stores every reading once, appends the new ones to a Google Sheet and answers with a comparison per phone.

It runs on the free community edition and uses only built-in nodes. Everything except the Google Sheets step was run on a real n8n 2.47.7.

| Asked for                                            | What you get                                                                                                                                                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which trigger? It does not fire, or fires twice      | A **Webhook**. The phone pushes the file, so there is no folder to watch and no poll to miss. Firing twice no longer matters: the same file, sent 8 times at the same moment, added its rows once.                                       |
| Is the phone done uploading when the workflow reads? | The file is the request. n8n starts only when the whole body has arrived. A file the app had not finished writing is caught where it can be: a last line with too few columns is skipped and named, a cut inside quotes is refused.      |
| How to not grab the same file twice                  | The hash of the file text is remembered. Each reading also has its own key, so an export that overlaps an older one adds only the new readings.                                                                                          |
| The CSV comes through as one column                  | The separator is detected (comma, semicolon, tab), `38,5` is read as 38.5, a byte order mark is removed, columns are found by their header in any order. A file that still has one column gets a `422` that says so. Nothing is written. |
| A small comparison per device                        | Readings, average and highest temperature, average battery drain per session, frame drops per hour. Worked out again on every upload, returned to the phone, and at a GET address.                                                       |
| Rows in a Google Sheet                               | An append node for new rows and one that keeps a Comparison tab up to date. Both are in the workflow, switched off until you add your credential. **Not tested against Google here.**                                                    |

## How it works

`POST /webhook/game-log/intake` with the header `X-Log-Key`. The CSV can come in three ways:

| Form        | Request                                                                              |
| ----------- | ------------------------------------------------------------------------------------ |
| File upload | `multipart/form-data` with the file in any field                                     |
| Raw body    | the text is the body, `Content-Type: text/csv` (or `text/plain`, or any binary type) |
| JSON        | `{ "csv": "the text", "device": "Pixel 7" }`                                         |

Say which phone it is with `?device=Pixel 7` in the address (or a `device` field, or the header `X-Device`). A `device` column in the file wins.

1. **Parse and check.** Finds the separator, splits the text with quotes respected (a note may hold commas, line breaks and `""`), finds the columns by header name, checks each line. The header can be in any order and in other words (`Temp (°C)`, `Battery %`, `Dropped frames`, `Timestamp`). Without a header, 4, 5 or 6 columns are read in the order set in **Settings**. Lines with a battery outside 0 to 100, a temperature that is not a number, frame drops that are not a whole number, or a time it cannot read are left out and listed in the answer with their line number.
2. **The same file twice.** The SHA-256 of the text goes into the data table `game_log_files`. A file that was imported before stops here. The Code node has no `crypto`, so the hash is written out in JavaScript in the node; the tests compare it with Node's own SHA-256.
3. **The same reading twice.** Each reading gets a key: the file's `id` column if it has one, else phone + time, else the whole row. Data tables have no unique column, and "look, then insert" lets two runs through together. So every run inserts first, then reads the rows for its keys: the lowest row id per key stays, and a run removes its own row if another was first. That order was measured in [n8n-webhook-dedupe](https://github.com/feversoul/n8n-webhook-dedupe).
4. **Google Sheet.** Only the rows that are new go to the **Log** tab. If the append fails, this run's rows are taken out of the data table again and the phone gets `502`, so sending the file again adds them.
5. **Compare devices.** From all stored rows. A session is the `session` column if the file has one, else readings on one phone with no pause longer than 30 minutes. Drain is the first battery reading of a session minus the last. Frame drops per hour is the drops of sessions with a duration, divided by their hours.

`GET /webhook/game-log/comparison` returns the comparison alone.

The answer to an upload:

```json
{
  "ok": true,
  "file_hash": "b740c35f…",
  "form": "raw body",
  "delimiter": "semicolon",
  "header": true,
  "rows_in_file": 7,
  "duplicate_file": false,
  "added": 3,
  "already_stored": 4,
  "conflicts": [],
  "conflict_count": 0,
  "rejected": [{ "line": 8, "reason": "battery \"140\" is not a number from 0 to 100" }],
  "rejected_count": 1,
  "rows_stored": 21,
  "comparison": [
    {
      "device": "Pixel 7",
      "readings": 7,
      "sessions": 3,
      "avg_temperature": 37.29,
      "max_temperature": 42.5,
      "avg_battery_drain_per_session": 12.5,
      "frame_drops_total": 31,
      "frame_drops_per_hour": 25.71,
      "hours_logged": 1.17,
      "first_reading": "2026-10-12T10:00:00",
      "last_reading": "2026-10-12T20:00:00"
    }
  ],
  "summary": "Pixel 7: 7 readings, avg 37.29 °C, max 42.5 °C, drain 12.5 % per session, 25.71 frame drops per hour"
}
```

| Code  | `error`               | Meaning                                                                           |
| ----- | --------------------- | --------------------------------------------------------------------------------- |
| `200` |                       | Read. `added` may be 0 when everything was stored before.                         |
| `400` | `no_csv`              | No CSV text in the request.                                                       |
| `422` | `one_column`          | No comma, semicolon, tab or `\|` between values. `first_line` shows what arrived. |
| `422` | `cut_off`             | The file ends inside a quoted field.                                              |
| `422` | `missing_columns`     | A header was found, but not battery, temperature, frame drops and note.           |
| `422` | `no_header`           | No header, and not 4, 5 or 6 columns.                                             |
| `422` | `no_device`           | No `?device=` and no device column.                                               |
| `422` | `no_rows`             | Not one usable line. `rejected` has the reasons.                                  |
| `413` | `too_many_rows`       | More than `MAX_ROWS` (2000).                                                      |
| `502` | `sheet_append_failed` | The Google Sheets append failed. Nothing was kept. Send again.                    |
| `403` |                       | Wrong or missing `X-Log-Key`.                                                     |

`conflicts` lists readings that are already stored with other values (same phone and time, another note). The stored row is kept.

## The shortcut on the phone

Not run on a phone here: the tests send the same three request shapes from Node. Option names are from the apps' documentation and may differ in your version.

Address: `https://your-n8n/webhook/game-log/intake?device=Pixel%207` (one shortcut per phone, each with its own device name). Header: `X-Log-Key` with your key. A self-hosted n8n has to be reachable from the phone: the same Wi-Fi with the computer's address (`http://192.168.x.x:5678/...`), or a tunnel or VPN.

**iOS Shortcuts**

1. **Get File** (the exported CSV in Files), or use the shortcut from the share sheet so the file is the Shortcut Input.
2. **Get Contents of URL**: URL as above, Method `POST`, Headers `X-Log-Key`, Request Body `File`, with the file from step 1. (Request Body `Form` with a field of type File works too.)
3. **Get Dictionary Value** `summary` from the result, then **Show Result**.

**Android, HTTP Shortcuts app**

1. New shortcut: Method `POST`, URL as above, request header `X-Log-Key`.
2. Request Body / Parameters: Request Body Type `File (Picker)`. Or `Parameters (form-data)` with one parameter of type `Single File`.
3. Share the CSV from the notes app into the shortcut, or pick it when the shortcut runs. Let it show the response.

**Android, Tasker**

Action **HTTP Request**: Method `POST`, URL as above, Headers `X-Log-Key:your key` and `Content-Type:text/csv` on two lines, **File To Send** the path of the export. The answer is in `%http_data`.

If the app can only give you text, send JSON: `{ "csv": "<the text>", "device": "Pixel 7" }` with `Content-Type: application/json`.

Running the shortcut twice, or the app retrying after a timeout, adds nothing twice.

## Add it to your n8n

For n8n Cloud or an n8n you already run (2.x).

1. Create a credential of type **Header Auth** named exactly `Game Log Key`: name `X-Log-Key`, value a long random string.
2. Import `workflows/0-setup.json` and `workflows/1-intake.json`.
3. Open **0 Setup** and press **Execute workflow**. It creates the data tables `game_log_rows` and `game_log_files`.
4. Open **1 Intake**, look at **Settings** (session pause, day/month order, column order for files without a header) and **publish** it. The phone must use the production address (`/webhook/...`), not the test address (`/webhook-test/...`), which only listens while the editor is open.
5. Google Sheet, when you want it: make a tab `Log` with the header row `logged_at, device, battery, temperature, frame_drops, note, session, row_key` and a tab `Comparison` with `device, readings, sessions, avg_temperature, max_temperature, avg_battery_drain_per_session, frame_drops_total, frame_drops_per_hour, hours_logged, first_reading, last_reading`. In **Append to Log tab** and **Update Comparison tab** choose your Google credential and the spreadsheet, switch both nodes on, publish again.

**Do not put a Google Sheets Trigger on the Log or Comparison tab.** The workflow writes to both, and each write fires such a trigger again. That was the double run the thread author found. If another workflow should react to new rows, let it watch a different tab, or call it from this workflow after **File done**.

## Try it with Docker

```bash
git clone https://github.com/feversoul/n8n-phone-csv-intake.git
cd n8n-phone-csv-intake
cp .env.example .env      # fill in two random strings
docker compose up -d

printf 'Time;Battery;Temp;Frame drops;Note\n2026-10-28 10:00;90;36,5;2;"menu; loading"\n2026-10-28 10:20;84;39,0;7;boss fight\n' > log.csv

curl -H "X-Log-Key: <your key>" -F "file=@log.csv" "localhost:5678/webhook/game-log/intake?device=Pixel%207"
curl -H "X-Log-Key: <your key>" -H "Content-Type: text/csv" --data-binary @log.csv "localhost:5678/webhook/game-log/intake?device=Pixel%207"
curl -H "X-Log-Key: <your key>" "localhost:5678/webhook/game-log/comparison"
```

The second upload answers `"duplicate_file": true, "added": 0`. With `curl`, use `--data-binary` and the `Content-Type` header: plain `-d` sends the text as a form and strips the line breaks.

## What was tested

`npm run test:e2e` starts a real n8n 2.47.7 in Docker, imports these workflows and posts real CSV text to the webhook. 18 tests, all pass, about a minute.

| Test                                                               | Result                                                                                                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| One file as file upload, raw body and JSON                         | Stored once (3 rows), the two later forms answer `duplicate_file`. Also with Windows line ends and a byte order mark. The hash equals Node's SHA-256. |
| Each form with a new file; device from address, field, header      | 7 combinations, each stored its 4 rows. Raw body as `text/csv`, `text/plain` and `application/octet-stream`.                                          |
| Overlapping exports (rows 1–4, then 3–7, then 1–7, then reordered) | 4, then 3, then 0, then 0 added. 7 readings stored.                                                                                                   |
| Semicolon file, `36,5`, `95%`, `42,0 °C`, CRLF, BOM, other headers | 3 rows, average 39.25, `sep=;` line also followed.                                                                                                    |
| Tab file, UTF-16 file, no header, no time column                   | All stored with the right values.                                                                                                                     |
| Notes with commas, semicolons, line breaks, quotes                 | Stored whole.                                                                                                                                         |
| One-column text, an HTML error page, empty body, missing column    | `422` or `400` with the reason, row count unchanged.                                                                                                  |
| 13 lines, 10 of them wrong in different ways                       | 2 stored, the 10 listed by line number with the reason.                                                                                               |
| File cut mid-row, then the complete file                           | 5 stored and the cut line named, then exactly 1 added. Cut inside quotes: `422`, nothing stored.                                                      |
| Upload broken off after half of the body (raw and JSON)            | The workflow did not run, nothing stored, the complete upload afterwards is new.                                                                      |
| The same file 8 times at the same moment, 6 rounds                 | 12 rows added per round in total, 12 stored. No copy was stopped by the file hash (they were too close); the row keys stopped them.                   |
| 8 overlapping exports of one phone at the same moment, 4 rounds    | 15 readings stored per round, none twice.                                                                                                             |
| Two phones posting at the same moment, 8 rounds                    | 10 and 7 rows, right numbers for both.                                                                                                                |
| Comparison numbers for two phones, by hand                         | Equal in the upload answer and at the GET address; a later export moves only that phone.                                                              |
| 300 rows, then the same export with one more                       | 300 added in about 2 s, then 1 added in about 3 s (on a laptop).                                                                                      |
| Google append fails (credential that cannot sign in)               | `502`, no row left in the data table, sending again is a new try.                                                                                     |

What was not tested, and other limits:

- **Google Sheets.** No real spreadsheet was used. The append and the Comparison update are standard Google Sheets nodes with auto-mapped columns, but a successful write to Google was never run. The failure path was run with a credential that cannot sign in, not with an error from Google itself.
- **A real phone.** No shortcut was run on iOS or Android.
- **n8n Cloud, PostgreSQL, queue mode.** The tests ran on one self-hosted n8n on SQLite, the default of the community edition. With n8n on PostgreSQL and several workers, the "lowest id stays" check has a gap that [n8n-webhook-dedupe](https://github.com/feversoul/n8n-webhook-dedupe) describes.
- **A cut the file does not show.** If the export stops inside the last note and that note has no quotes, the line looks complete and is stored with the short note. The complete file later reports it under `conflicts` and keeps the short one. Fix that row by hand in the data table.
- **Two readings of one phone in the same minute**, in a file without an `id` column and with times to the minute, count as the same reading. The second is listed under `conflicts` or `rejected`, not stored.
- **A file with no time and no id** is keyed by the whole row, so two truly equal readings become one.
- **Times** are kept as written, without a time zone. Read: `2026-10-28 14:05`, `2026-10-28T14:05:00Z`, `28.10.2026 14:05`, `28/10/2026 2:05 pm` (or month first, see **Settings**), Unix seconds. Month names are not read.
- **An edited note is not updated.** Stored rows are never changed by a later file.
- **Sheet failure while another copy runs.** If the append of one run fails while a second copy of the same file was answered "already stored", those rows are gone until the file is sent again.
- **The comparison reads every stored row** on each call. That is fine for a personal log; it was not tried beyond 300 rows per file and under a thousand rows in the table.

## Change the workflows

The files in `workflows/` are generated by [`scripts/build.mjs`](scripts/build.mjs) so the JavaScript of the Code nodes can live in `src/`. Edit them in the n8n editor like any workflow, or change the source and run `npm run build`.

MIT licence.
