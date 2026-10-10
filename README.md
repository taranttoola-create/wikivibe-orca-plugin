# WikiVibe Gateway для Orca

Самостоятельный плагин `wikivibe.gateway`: регистрация WikiVibe, API-ключ, каталог моделей и обратимая настройка семи совместимых CLI. Без форка Orca, отдельного helper и production-зависимостей. Требуется Orca с experimental plugin API 1; manifest допускает версии от 1.4.214, парсер и IPC worker проверены на 1.4.223.

## Обычная установка

1. В Orca откройте **Settings → Plugins**, включите **Plugin system**.
2. Выберите **Install plugin → Local folder** и укажите абсолютный путь к папке этого проекта с `orca-plugin.json`. Это обычная установка: Orca копирует плагин в своё хранилище. Не нужно добавлять Development path или менять внутренние файлы Orca.
3. Проверьте разрешения и включите **WikiVibe Gateway**. До согласия код не запускается.
4. Выполните команду **WikiVibe: Настроить** через палитру команд Orca. Откроется локальная страница в браузере по умолчанию.

Для переноса готовых файлов разработчик может выполнить `npm run package:plugin`: в `dist/` появятся самостоятельная папка плагина и `.tar.gz`. Установите папку через Local folder; архив сначала распакуйте. Node/npm нужны для разработки и упаковки, не для установки готовой папки: worker использует runtime Orca.

Репозиторий: https://github.com/taranttoola-create/wikivibe-orca-plugin. Для обычной установки через **Install plugin → Git URL** используйте `https://github.com/taranttoola-create/wikivibe-orca-plugin.git#4521ffe` — фиксированный commit первой версии плагина. Публикация в marketplace пока не выполнена. Чтобы подготовить marketplace index, выполните `node scripts/marketplace.mjs https://github.com/taranttoola-create/wikivibe-orca-plugin.git 4521ffe` и сохраните результат как `orca-marketplace.json` в своём marketplace-репозитории.

## Подключение

1. **Зарегистрироваться** открывает https://api.wikivibe.dev/register?aff=9YAJBL6HLM23.
2. Введите ключ и выберите `https://api.wikivibe.dev/v1` или `https://vapi.wikivibe.dev/v1`.
3. Плагин проверяет `GET /models` с Bearer authentication, затем сохраняет ключ в зашифрованном vault Orca. При отказе API прежний ключ не заменяется.
4. Выберите модель из каталога и сохраните настройки. При смене endpoint обновите каталог.
5. Выберите агентов, откройте **Посмотреть изменения**, прочитайте пути и предупреждения. Для применения явно согласитесь на plaintext ключ в нативных файлах.
6. Запустите **новую** сессию агента в Orca. Проверьте выбранный provider/model и отправьте короткий запрос. Наличие модели в каталоге не гарантирует streaming, tool calls или поддержку протокола агента.

Дополнительные команды: **WikiVibe: Проверить подключение** обновляет каталог; **WikiVibe: Удалить ключ плагина** удаляет только vault key, не конфигурации агентов.

## Агенты и границы

| Агент | Нативная конфигурация в домашнем каталоге | Протокол |
| --- | --- | --- |
| Claude Code | `.claude/settings.json`, `env.ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, модель | Anthropic Messages; base URL без `/v1` |
| Codex | `.codex/config.toml`, `model_provider`, `[model_providers.wikivibe]` | OpenAI Responses; `experimental_bearer_token` зависит от версии CLI |
| OpenCode | `.config/opencode/opencode.json`, custom provider `@ai-sdk/openai-compatible` | OpenAI Chat Completions |
| Pi | `.pi/agent/models.json` и `settings.json` | OpenAI Chat Completions |
| oh-my-pi | `.omp/agent/models.yml`/`.yaml`, `config.yml`/`.yaml`, `modelRoles.default` | OpenAI Chat Completions |
| Aider | `.aider.conf.yml`, `openai-api-base`, `openai-api-key`, модель с routing prefix `openai/` | OpenAI Chat Completions |
| Qwen Code | `.qwen/settings.json`, `modelProviders.openai`, `env`, startup auth | OpenAI Chat Completions |

Доступность в UI означает наличие адаптера, **не** обнаружение установленного CLI. Каждый формат основан на документации соответствующего агента; реальные CLI-версии могут отличаться. Подтверждено чтение нативной конфигурации установленными OpenCode и OMP в изолированном HOME. Остальные адаптеры проверены behavioral tests, не реальным запуском CLI.

Обрабатываются только **default local home paths**. Пользовательские профили Orca, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`, настройки проекта, env, managed settings и CLI flags могут переопределить их. SSH/WSL и remote agent home не настраиваются. Плагин не меняет настройки запуска Orca и не регистрирует новые harnesses через неподключённый `contributes.agents`.

Cursor, Windsurf, Antigravity, Gemini и другие агенты без реализованного здесь нативного адаптера не подключаются автоматически. JSONC, anchors/tags/merge YAML и сложный TOML не переписываются; конфликтующие credentials/providers отклоняются. Существующий provider `wikivibe`, созданный не этим плагином, не перезаписывается.

## Секреты и восстановление

- Собственный ключ хранится через `secrets` Orca с OS-backed encryption; plaintext fallback отсутствует. Модель/endpoint — через `storage`.
- У CLI ключ остаётся **открытым текстом** после явного согласия. Config и backup files получают `0600`, backup directory — `0700` на POSIX. Windows mode bits не заменяют NTFS ACL; держите профиль пользователя закрытым другим пользователям.
- Backup record находится рядом с файлом в `.wikivibe-gateway-backups/`. Он может содержать старые credentials: не публикуйте и не добавляйте в Git.
- **Восстановить из копий** возвращает исходные байты/права или удаляет только созданный плагином config. При последующих пользовательских изменениях восстановление запрещено: сохраните свои изменения и сравните с backup вручную.
- Применение выполняется по файлам, не общей транзакцией. При сбое часть файлов может быть уже изменена; восстановите выбранные конфигурации. Pending/restoring records позволяют безопасно завершить восстановление.
- После аварии может остаться `~/.wikivibe-gateway.lock`. Не удаляйте его, пока worker/операция живы. После полного отключения плагина можно удалить stale lock вручную и восстановить конфигурации.
- **Отключить** удаляет только ключ из vault. Сначала восстановите агенты, если хотите убрать ключ из их файлов; удаление плагина также не восстанавливает их автоматически. Для полной ревокации отзовите ключ в WikiVibe.

Worker — доверенный Node-процесс с доступом к filesystem/network; перечисленные capabilities ограничивают host API, а не являются OS sandbox. Разрешения: `secrets`, `storage`, `notifications:show`.

Локальная страница слушает только `127.0.0.1`, требует случайный token из fragment и Authorization, проверяет Host/Origin, ограничивает JSON body, запрещает iframe и внешние assets через CSP. Token не хранится в cookies/localStorage и удаляется из адреса. После reload откройте настройку заново. Локальный сервер закрывается после четырёх минут бездействия; Orca может остановить worker через пять минут после команды, даже при активности страницы. Не пересылайте URL настройки.

## Проверка разработчиком

```sh
npm test
npm run check
npm run smoke
node scripts/smoke.mjs --fixture
node scripts/agent-smoke.mjs /absolute/path/to/opencode
node scripts/agent-smoke.mjs /absolute/path/to/omp omp
node scripts/worker-smoke.mjs /absolute/path/to/Orca /absolute/path/to/app.asar/out/main/plugin-host-entry.js
npm run package:plugin
```

Tests/smoke используют temporary HOME и не меняют реальные конфигурации. `--fixture` — только проверочный каталог, не production fallback. `npm run smoke` проверяет отказ реального API неверному ключу. Worker smoke использует настоящий installed Orca IPC worker с изолированным host storage, но не заменяет проверку установки через UI.

Проверено: manifest принят installed Orca; IPC activation/commands/host calls/shutdown; 20 behavioral tests; localhost HTTP и browser workflow connect → preferences → preview → consent → apply → restore → endpoint switch → disconnect; reload без token; mobile DOM без горизонтального overflow. PNG screenshot сохранён при smoke; автоматический визуальный анализ изображения был недоступен. Успешный запрос реальной модели не проверен: действительный пользовательский ключ не предоставлен. Установка в Settings UI не проверена: `orca skills get orca-cli` завершился таймаутом 30 секунд. Эти ограничения не скрыты за fixture.

## Первичные источники

- [Orca Settings → Plugins](https://www.onorca.dev/docs/settings#plugins-experimental), [Install plugin UI](https://github.com/stablyai/orca/blob/main/src/renderer/src/components/settings/PluginInstallDialog.tsx), [пример worker](https://github.com/stablyai/orca/tree/main/examples/plugins/hello-orca).
- [Claude gateway](https://code.claude.com/docs/en/llm-gateway-connect).
- [Codex config reference](https://developers.openai.com/codex/config-reference).
- [OpenCode config](https://opencode.ai/docs/config/), [providers](https://opencode.ai/docs/providers/).
- [Pi model configuration](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md).
- [OMP models](https://github.com/can1357/oh-my-pi/blob/main/docs/models.md).
- [Aider OpenAI-compatible endpoints](https://aider.chat/docs/llms/openai-compat.html), [config](https://aider.chat/docs/config/aider_conf.html).
- [Qwen authentication/configuration](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/).
