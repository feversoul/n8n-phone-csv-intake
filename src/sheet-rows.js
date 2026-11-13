// One item per new row, with the column names of the Log tab.
return $('Keep the first')
  .first()
  .json.added.map((row) => ({
    json: {
      logged_at: row.logged_at,
      device: row.device,
      battery: row.battery,
      temperature: row.temperature,
      frame_drops: row.frame_drops,
      note: row.note,
      session: row.session,
      row_key: row.row_key,
    },
  }));
