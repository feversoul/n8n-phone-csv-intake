// Finds the CSV text in the request, whichever way the phone sent it:
//   1. a file upload (multipart form, any field name)
//   2. the raw text as the body (Content-Type text/csv, text/plain or none)
//   3. JSON or a form with the text in "csv" (also "text", "content", "data", "file")
// The phone can say which device it is with ?device=NAME in the address, a
// "device" field next to the file, or the header X-Device.

const item = $input.first();
const { request } = item.json;
const body = request.body;
const fields = body && typeof body === 'object' && !Array.isArray(body) ? body : {};

let bytes = null;
let form = 'none';
let filename = '';

const files = Object.keys(item.binary ?? {});
if (files.length > 0) {
  const file = item.binary[files[0]];
  bytes = await this.helpers.getBinaryDataBuffer(0, files[0]);
  // n8n stores a raw body as a file too; only a multipart upload has fields or a real file name.
  form = String(request.headers['content-type'] ?? '').startsWith('multipart/') ? 'file upload' : 'raw body';
  filename = form === 'file upload' ? String(file.fileName ?? '') : '';
} else if (typeof body === 'string') {
  bytes = Buffer.from(body, 'utf8');
  form = 'raw body';
} else {
  const key = ['csv', 'text', 'content', 'data', 'file'].find((name) => typeof fields[name] === 'string' && fields[name].trim() !== '');
  if (key) {
    bytes = Buffer.from(fields[key], 'utf8');
    form = 'text field';
  }
}

// Bytes to text. A byte order mark at the start says which encoding it is and is not part of the first column name.
let text = '';
if (bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be').decode(bytes.subarray(2));
  else text = bytes.toString('utf8');
  text = text.replace(/^﻿/, '');
}

const pick = (value) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '');
return [
  {
    json: {
      form,
      text,
      filename: filename || pick(fields.filename) || pick(request.query?.filename),
      device: pick(request.query?.device) || pick(fields.device) || pick(request.headers['x-device']),
    },
  },
];
