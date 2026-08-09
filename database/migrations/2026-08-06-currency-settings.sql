insert into website_settings (setting_key, setting_value, setting_group, setting_type, is_public, description)
values (
  'supported_currencies',
  '[
    {"code":"USD","name":"US Dollar","symbol":"$","locale":"en-US","decimalDigits":2,"enabled":true},
    {"code":"EUR","name":"Euro","symbol":"€","locale":"de-DE","decimalDigits":2,"enabled":true},
    {"code":"GBP","name":"British Pound","symbol":"£","locale":"en-GB","decimalDigits":2,"enabled":true},
    {"code":"TZS","name":"Tanzanian Shilling","symbol":"TSh","locale":"sw-TZ","decimalDigits":0,"enabled":true},
    {"code":"KES","name":"Kenyan Shilling","symbol":"KSh","locale":"en-KE","decimalDigits":0,"enabled":true},
    {"code":"ZAR","name":"South African Rand","symbol":"R","locale":"en-ZA","decimalDigits":2,"enabled":true},
    {"code":"AUD","name":"Australian Dollar","symbol":"A$","locale":"en-AU","decimalDigits":2,"enabled":true},
    {"code":"CAD","name":"Canadian Dollar","symbol":"CA$","locale":"en-CA","decimalDigits":2,"enabled":true}
  ]',
  'currencies',
  'json',
  false,
  'CMS-managed supported display currencies for exchange-rate fetching and frontend selection.'
)
on conflict (setting_key) do nothing;

update website_settings
set setting_group = 'currencies',
    setting_type = 'select',
    is_public = true,
    description = 'Default display currency for visitors who have not selected one.'
where setting_key = 'default_currency';
