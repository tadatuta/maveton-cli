# Спецификации и границы поддержки

Дата сверки: **6 ноября 2026 года**.

## Podcasting 2.0

Источник: [Podcastindex-org/podcast-namespace](https://github.com/Podcastindex-org/podcast-namespace), commit [`d4036dcb1047ad654682e1142734e3acf2c13f37`](https://github.com/Podcastindex-org/podcast-namespace/tree/d4036dcb1047ad654682e1142734e3acf2c13f37).

Реализован полный набор из [основного документа 1.0](https://github.com/Podcastindex-org/podcast-namespace/blob/d4036dcb1047ad654682e1142734e3acf2c13f37/docs/1.0.md): 31 действующий тег и устаревший `images`. Правила берутся из отдельных описаний `docs/tags/*.md`. Новая множественная `location` с `rel` и `country`, `image`, Lightning Address и `txt purpose=ai-content` входят в эту версию.

Основной URI namespace — `https://podcastindex.org/namespace/1.0`. Его документированный GitHub-алиас и любые XML-префиксы распознаются. Существующие теги других namespace сохраняются. При добавлении новых тегов используется основной URI.

В `src/spec-data.ts` зафиксированы идентификаторы из `taxonomy.json`, `socialprotocols.txt`, `serviceslugs.txt`, `docs/chatprotocols.txt` и `docs/examples/license/licenses.json`. Незнакомые роли/протоколы вызывают предупреждение, так как реестры могут развиваться отдельно от программы.

Описания отдельных утверждённых тегов имеют приоритет над старыми companion-документами и XSD, которые могут отставать. Например, современный `license` требует URL только для пользовательской лицензии, `valueRecipient` поддерживает `lnaddress`, а `remoteItem` разрешён внутри `publisher` и `valueTimeSplit`. Для `socialInteract protocol=disabled` применяется явно описанное исключение из требования URI.

Поддержка тега означает возможность выразить его входным деревом и сохранить в RSS с проверкой его локальной структуры и основных типов/ограничений. CLI не является проигрывателем или платёжным клиентом, не отправляет Podping и не проверяет удалённые ресурсы. Проверка RRULE не вычисляет календарь, страна проверяется синтаксически; подпись и адрес проверяются по форме, а не криптографически.

## Платформы и RSS

- [RSS 2.0 Specification](https://www.rssboard.org/rss-specification): структура channel/item, enclosure, GUID.
- [Apple — Podcast RSS feed requirements](https://podcasters.apple.com/support/823-podcast-requirements): общий технический профиль RSS.
- [Apple — категории](https://podcasters.apple.com/support/1691-apple-podcasts-categories): точные имена категорий и подкатегорий для `src/categories.ts`.
- [Apple — валидация RSS](https://podcasters.apple.com/support/829-validate-your-podcast): граница между технической проверкой и одобрением публикации.
- [Spotify — Podcast specification doc](https://support.spotify.com/us/creators/article/podcast-specification-doc/): точка входа в официальную спецификацию. При сверке использовалась публично доступная [Podcast Delivery Specification v1.10, May 2025](https://assets.ctfassets.net/jtdj514wr91r/4r4op9KhH3fY1t3BKt2eiH/7b1b682acf4c41baf79f9574d6dedd7f/Podcast_Delivery_Specification_v1.10_-_master_doc.pdf).
- [YouTube — Deliver podcasts using an RSS feed](https://support.google.com/youtube/answer/13525207?hl=en): сценарий импорта аудиоподкастов через YouTube Studio.

CLI использует **единый консервативный профиль**, а не переключатель платформ. Например, основной enclosure — MP3/AAC в MP4, boolean explicit — `true/false`, URLs — HTTPS. Это может отклонить фид, допустимый для отдельной платформы или RSS-клиента. Альтернативные форматы описываются в Podcasting 2.0.

Доступность файлов, серверные HEAD/Range, фактические размеры/кодеки, обложки, содержимое внешних глав/транскриптов, права и платформенные ограничения не проверяются. Успех локального валидатора не является сертификацией Apple, Spotify или YouTube.
