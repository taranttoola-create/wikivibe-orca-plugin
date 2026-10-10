# Changelog

## 1.0.0

- Самостоятельный Orca API 1 plugin `wikivibe.gateway`, обычная установка из Local folder или опубликованного Git source; отдельный helper не требуется.
- Регистрация с affiliate URL, API/VAPI allowlist, проверка каталога до сохранения ключа в Orca vault, выбор модели.
- Защищённая loopback UI с explicit consent, preview, apply, restore и disconnect.
- Семь нативных config adapters: Claude Code, Codex, OpenCode, Pi, oh-my-pi, Aider, Qwen Code. Aider custom models маршрутизируются через `openai/` по документации.
- Per-file backups, POSIX permissions, конфликтное восстановление без перезаписи последующих пользовательских изменений.
- Документированы protocol, profile, remote/WSL, plaintext-secret и worker-lifetime ограничения; marketplace publication и успешный inference не заявлены.
