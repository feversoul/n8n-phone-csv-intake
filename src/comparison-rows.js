// One item per phone, with the column names of the Comparison tab.
return $('Compare devices')
  .first()
  .json.devices.map((device) => ({ json: device }));
