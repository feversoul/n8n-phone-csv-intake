// One item per row of the file, each marked with this run's token.
const { token } = $('Settings').first().json;
const file = $('Parse and check').first().json;
return file.rows.map((row) => ({ json: { ...row, token, file_hash: file.file_hash } }));
