// Only these fixed categories may cross the credential submission boundary.
export class ConnectionError extends Error {
  constructor(code) {
    super(CONNECTION_MESSAGES[code] ?? CONNECTION_MESSAGES.unknown);
    this.code = code;
  }
}

export const CONNECTION_MESSAGES = Object.freeze({
  key_format: 'Введите API-ключ без пробелов и управляющих символов.',
  endpoint: 'Выберите один из поддерживаемых адресов API WikiVibe.',
  api_network: 'Не удалось связаться с WikiVibe. Лимит ожидания — 15 секунд. Проверьте сеть и адрес API.',
  api_auth: 'WikiVibe отклонил ключ или доступ к выбранному адресу API (HTTP 401/403).',
  api_limit: 'Достигнут лимит запросов WikiVibe (HTTP 429). Повторите позже.',
  api_http: 'WikiVibe вернул ошибку при загрузке данных API.',
  api_catalog: 'WikiVibe вернул некорректный или слишком большой каталог доступных моделей.',
  api_account: 'WikiVibe вернул некорректные или слишком большие данные лимитов и расходов.',
  storage: 'API принял ключ, но Orca не смогла сохранить настройки или ключ в защищённом хранилище. Проверьте разрешения secrets и storage в Settings → Plugins.',
  unknown: 'Не удалось проверить и сохранить ключ. Откройте защищённую настройку заново и проверьте разрешения плагина.'
});
